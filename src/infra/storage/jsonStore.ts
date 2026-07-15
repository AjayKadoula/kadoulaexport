/**
 * JSON-file storage driver. Used as a fallback where the native SQLite module
 * isn't available, and as a fast in-memory store for tests. Implements exactly
 * the same Storage contract as the SQLite driver (both pass the shared suite).
 *
 * Persistence model: the whole store is held in memory and flushed to a single
 * JSON file after each mutation. For a personal desktop app with modest data
 * this is perfectly adequate; the SQLite driver is preferred for large history.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  Alert,
  DeliveryOutcome,
  Location,
  Observation,
  PlatformId,
  PlatformSettings,
  Product,
  Target,
  Transition,
} from '../../core/types';
import { EventRecord, HistoryQuery, ProfileRecord, RetentionPolicy, Storage } from './types';

interface Db {
  products: Record<string, Product>;
  platforms: Record<string, PlatformSettings>;
  locations: Record<string, Location>;
  profiles: Record<string, ProfileRecord>;
  targets: Record<string, Target>;
  resolutions: Record<string, { url?: string; platformRef?: string }>;
  observations: { targetId: string; obs: Observation }[];
  transitions: Transition[];
  alerts: Alert[];
  deliveries: { alertId: string; d: DeliveryOutcome }[];
  dedup: string[];
  events: EventRecord[];
  settings: Record<string, unknown>;
}

function emptyDb(): Db {
  return {
    products: {},
    platforms: {},
    locations: {},
    profiles: {},
    targets: {},
    resolutions: {},
    observations: [],
    transitions: [],
    alerts: [],
    deliveries: [],
    dedup: [],
    events: [],
    settings: {},
  };
}

export class JsonStorage implements Storage {
  private db: Db = emptyDb();
  private eventSeq = 0;

  /** filePath undefined => pure in-memory (tests). */
  constructor(private readonly filePath?: string) {}

  init(): void {
    if (this.filePath && existsSync(this.filePath)) {
      try {
        this.db = { ...emptyDb(), ...JSON.parse(readFileSync(this.filePath, 'utf8')) };
      } catch {
        this.db = emptyDb();
      }
    }
  }

  close(): void {
    this.flush();
  }

  private flush(): void {
    if (!this.filePath) return;
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(this.db));
  }

  upsertProduct(p: Product): void {
    this.db.products[p.id] = p;
    this.flush();
  }
  deleteProduct(id: string): void {
    delete this.db.products[id];
    this.flush();
  }
  listProducts(): Product[] {
    return Object.values(this.db.products);
  }
  getProduct(id: string): Product | undefined {
    return this.db.products[id];
  }

  setPlatformSettings(id: PlatformId, s: PlatformSettings): void {
    this.db.platforms[id] = s;
    this.flush();
  }
  getPlatformSettings(id: PlatformId): PlatformSettings | undefined {
    return this.db.platforms[id];
  }
  listPlatformSettings(): Record<string, PlatformSettings> {
    return { ...this.db.platforms };
  }

  upsertLocation(l: Location): void {
    this.db.locations[l.pincode] = l;
    this.flush();
  }
  deleteLocation(pincode: string): void {
    delete this.db.locations[pincode];
    this.flush();
  }
  listLocations(): Location[] {
    return Object.values(this.db.locations);
  }

  upsertProfile(p: ProfileRecord): void {
    this.db.profiles[p.id] = p;
    this.flush();
  }
  deleteProfile(id: string): void {
    delete this.db.profiles[id];
    this.flush();
  }
  listProfiles(): ProfileRecord[] {
    return Object.values(this.db.profiles);
  }

  upsertTarget(t: Target): void {
    this.db.targets[t.id] = { ...t };
    this.flush();
  }
  deleteTarget(id: string): void {
    delete this.db.targets[id];
    this.flush();
  }
  listTargets(): Target[] {
    return Object.values(this.db.targets).map((t) => ({ ...t }));
  }
  saveTargetState(t: Target): void {
    this.db.targets[t.id] = { ...t };
    this.flush();
  }

  recordObservation(targetId: string, obs: Observation): void {
    this.db.observations.push({ targetId, obs });
    this.flush();
  }

  commitTransition(
    transition: Transition,
    alert: Alert | undefined,
    deliveries: DeliveryOutcome[] | undefined,
    edge: string | undefined,
  ): void {
    this.db.transitions.push(transition);
    if (alert) this.db.alerts.push(alert);
    if (deliveries && alert) {
      for (const d of deliveries) this.db.deliveries.push({ alertId: alert.id, d });
    }
    if (edge && !this.db.dedup.includes(edge)) this.db.dedup.push(edge);
    this.flush();
  }

  loadDedupKeys(): string[] {
    return [...this.db.dedup];
  }

  saveResolution(targetId: string, ref: { url?: string; platformRef?: string }): void {
    this.db.resolutions[targetId] = ref;
    this.flush();
  }
  getResolution(targetId: string): { url?: string; platformRef?: string } | undefined {
    return this.db.resolutions[targetId];
  }

  recordEvent(e: EventRecord): void {
    this.eventSeq += 1;
    this.db.events.push({ ...e, id: this.eventSeq });
    this.flush();
  }

  queryTransitions(q: HistoryQuery): Transition[] {
    return paginate(
      this.db.transitions
        .filter((t) => inRange(t.at, q) && (!q.targetId || t.targetId === q.targetId))
        .sort((a, b) => b.at - a.at),
      q,
    );
  }

  queryAlerts(q: HistoryQuery): Alert[] {
    return paginate(
      this.db.alerts
        .filter(
          (a) =>
            inRange(a.at, q) &&
            (!q.targetId || a.targetId === q.targetId) &&
            (!q.platformId || a.platformId === q.platformId) &&
            (!q.text || a.productName.toLowerCase().includes(q.text.toLowerCase())),
        )
        .sort((a, b) => b.at - a.at),
      q,
    );
  }

  queryEvents(q: HistoryQuery): EventRecord[] {
    return paginate(
      this.db.events
        .filter((e) => inRange(e.at, q) && (!q.text || e.message.toLowerCase().includes(q.text.toLowerCase())))
        .sort((a, b) => b.at - a.at),
      q,
    );
  }

  setSetting(key: string, value: unknown): void {
    this.db.settings[key] = value;
    this.flush();
  }
  getSetting<T>(key: string): T | undefined {
    return this.db.settings[key] as T | undefined;
  }

  runRetention(policy: RetentionPolicy, now: number): { observationsPruned: number } {
    const cut = now - policy.observationDays * 86_400_000;
    const before = this.db.observations.length;
    this.db.observations = this.db.observations.filter((o) => o.obs.at >= cut);
    this.flush();
    return { observationsPruned: before - this.db.observations.length };
  }
}

function inRange(at: number, q: HistoryQuery): boolean {
  if (q.from && at < q.from) return false;
  if (q.to && at > q.to) return false;
  return true;
}
function paginate<T>(arr: T[], q: HistoryQuery): T[] {
  const off = q.offset ?? 0;
  const lim = q.limit ?? 200;
  return arr.slice(off, off + lim);
}
