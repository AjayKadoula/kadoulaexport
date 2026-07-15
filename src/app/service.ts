/**
 * MonitoringService — the application core that wires the pure engine to real
 * infrastructure (storage, adapters, alerts, sessions, clock, net probe) and
 * exposes a clean API for the UI / IPC layer. This is what the Electron main
 * process instantiates; it is also what the demo script and soak test drive.
 */

import {
  AlertChannel,
  Clock,
  Location,
  NetworkProbe,
  PlatformId,
  PlatformSettings,
  Product,
  Target,
} from '../core/types';
import { Engine, EngineNotice } from '../core/engine';
import { Dispatcher, QuietHours } from '../alerts/dispatcher';
import { AdapterRuntime } from '../adapters/runtime';
import { buildAdapters, ALL_PLATFORM_IDS, MANIFESTS } from '../adapters/registry';
import { Storage, RetentionPolicy } from '../infra/storage/types';
import { Logger } from '../core/types';
import { materialize } from './materialize';
import { SessionManager } from '../session/sessionManager';

export interface ServiceDeps {
  storage: Storage;
  runtime: AdapterRuntime;
  channels: AlertChannel[];
  clock: Clock;
  netProbe: NetworkProbe;
  logger: Logger;
  sessionManager?: SessionManager;
  quietHours?: QuietHours;
  retention?: RetentionPolicy;
  random?: () => number;
  onNotice?(notice: EngineNotice): void;
  /** For deterministic dispatcher quiet-hours in tests. */
  localHour?: (at: number) => number;
}

const DEFAULT_RETENTION: RetentionPolicy = {
  observationDays: 30,
  transitionDays: 365,
  alertDays: 365,
};

export class MonitoringService {
  readonly engine: Engine;
  private readonly dispatcher: Dispatcher;
  private products: Product[] = [];
  private locations: Location[] = [];
  private platforms: Record<string, PlatformSettings> = {};
  private targetsById = new Map<string, Target>();
  private retentionTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly deps: ServiceDeps) {
    this.dispatcher = new Dispatcher({
      channels: deps.channels,
      clock: deps.clock,
      logger: deps.logger.child('alerts'),
      quietHours: deps.quietHours,
      localHour: deps.localHour,
    });
    const adapters = buildAdapters(deps.runtime);
    this.engine = new Engine({
      clock: deps.clock,
      netProbe: deps.netProbe,
      logger: deps.logger.child('engine'),
      adapters,
      storage: deps.storage,
      dispatcher: this.dispatcher,
      getProduct: (id) => this.products.find((p) => p.id === id),
      random: deps.random,
      onNotice: (n) => this.handleNotice(n),
    });
  }

  /** Load persisted config + target state and prepare the engine to run. */
  restore(): void {
    this.products = this.deps.storage.listProducts();
    this.locations = this.deps.storage.listLocations();
    this.platforms = this.deps.storage.listPlatformSettings();
    // Default platform settings for any platform never configured.
    for (const id of ALL_PLATFORM_IDS) {
      if (!this.platforms[id]) {
        this.platforms[id] = { enabled: true, useAuthenticatedSession: false };
      }
    }
    const existing = new Map(this.deps.storage.listTargets().map((t) => [t.id, t]));
    this.rematerialize(existing);
    this.deps.logger.info('service restored', {
      products: this.products.length,
      locations: this.locations.length,
      targets: this.targetsById.size,
    });
  }

  private rematerialize(existing?: Map<string, Target>): void {
    const targets = materialize({
      products: this.products,
      platforms: this.platforms,
      locations: this.locations,
      now: this.deps.clock.now(),
      existing: existing ?? this.targetsById,
    });
    this.targetsById = new Map(targets.map((t) => [t.id, t]));
    for (const t of targets) this.deps.storage.upsertTarget(t);
    this.engine.setTargets(targets);
  }

  async start(tickIntervalMs = 1000): Promise<void> {
    this.deps.storage.recordEvent({
      at: this.deps.clock.now(),
      kind: 'lifecycle',
      level: 'info',
      source: 'service',
      message: 'monitoring started',
    });
    await this.engine.start(tickIntervalMs);
    this.scheduleRetention();
  }

  async stop(): Promise<void> {
    await this.engine.stop();
    if (this.retentionTimer) clearInterval(this.retentionTimer);
    this.deps.storage.recordEvent({
      at: this.deps.clock.now(),
      kind: 'lifecycle',
      level: 'info',
      source: 'service',
      message: 'monitoring stopped',
    });
  }

  // --- config mutations (persist + re-materialise) -------------------------

  addProduct(p: Product): void {
    this.deps.storage.upsertProduct(p);
    this.products = this.deps.storage.listProducts();
    this.rematerialize();
    this.audit('product added', { id: p.id, name: p.name });
  }

  removeProduct(id: string): void {
    this.deps.storage.deleteProduct(id);
    this.products = this.deps.storage.listProducts();
    this.rematerialize();
    this.audit('product removed', { id });
  }

  addLocation(l: Location): void {
    this.deps.storage.upsertLocation(l);
    this.locations = this.deps.storage.listLocations();
    this.rematerialize();
    this.audit('location added', { pincode: l.pincode });
  }

  removeLocation(pincode: string): void {
    this.deps.storage.deleteLocation(pincode);
    this.locations = this.deps.storage.listLocations();
    this.rematerialize();
    this.audit('location removed', { pincode });
  }

  setPlatformEnabled(id: PlatformId, enabled: boolean): void {
    const cur = this.platforms[id] ?? { enabled, useAuthenticatedSession: false };
    this.platforms[id] = { ...cur, enabled };
    this.deps.storage.setPlatformSettings(id, this.platforms[id]!);
    this.rematerialize();
    this.audit('platform toggled', { id, enabled });
  }

  // --- views for the UI ----------------------------------------------------

  getTargets(): Target[] {
    return [...this.engine.getTargets()];
  }

  getDashboard(): {
    offline: boolean;
    targets: Target[];
    platformHealth: Record<string, { manifest: string; minSpacingS: number }>;
  } {
    const health: Record<string, { manifest: string; minSpacingS: number }> = {};
    for (const id of ALL_PLATFORM_IDS) {
      health[id] = { manifest: MANIFESTS[id].name, minSpacingS: MANIFESTS[id].minSpacingS };
    }
    return { offline: this.engine.isOffline(), targets: this.getTargets(), platformHealth: health };
  }

  private handleNotice(n: EngineNotice): void {
    if (n.kind === 'needs-login' && this.deps.sessionManager) {
      void this.deps.sessionManager.reportAuthFailure(n.platformId);
    }
    this.deps.storage.recordEvent({
      at: this.deps.clock.now(),
      kind: 'notice',
      level: n.kind === 'offline' || n.kind === 'degraded' ? 'warn' : 'info',
      source: 'engine',
      message: noticeMessage(n),
    });
    this.deps.onNotice?.(n);
  }

  private audit(message: string, data: unknown): void {
    this.deps.storage.recordEvent({
      at: this.deps.clock.now(),
      kind: 'user-action',
      level: 'info',
      source: 'ui',
      message,
      data,
    });
  }

  private scheduleRetention(): void {
    const policy = this.deps.retention ?? DEFAULT_RETENTION;
    const run = (): void => {
      try {
        const res = this.deps.storage.runRetention(policy, this.deps.clock.now());
        if (res.observationsPruned > 0) {
          this.deps.logger.info('retention pruned observations', res);
        }
      } catch (err) {
        this.deps.logger.error('retention failed', { err: String(err) });
      }
    };
    this.retentionTimer = setInterval(run, 24 * 60 * 60 * 1000);
    if (typeof this.retentionTimer === 'object' && 'unref' in this.retentionTimer) {
      (this.retentionTimer as { unref(): void }).unref();
    }
  }
}

function noticeMessage(n: EngineNotice): string {
  switch (n.kind) {
    case 'offline': return 'connectivity lost — monitoring paused';
    case 'online': return 'connectivity restored — monitoring resumed';
    case 'degraded': return `target degraded: ${n.target.id}`;
    case 'recovered': return `target recovered: ${n.target.id}`;
    case 'needs-login': return `platform needs sign-in: ${n.platformId}`;
  }
}
