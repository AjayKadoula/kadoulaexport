/**
 * The full Storage port used by the application (superset of the engine's
 * EngineStorage). Two drivers implement it: SQLite (production) and a JSON
 * file store (fallback / tests). Both pass the same contract suite.
 */

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

export interface EventRecord {
  id?: number;
  at: number;
  kind: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  source: string;
  message: string;
  data?: unknown;
}

export interface HistoryQuery {
  from?: number;
  to?: number;
  targetId?: string;
  platformId?: PlatformId;
  kind?: 'transition' | 'alert' | 'event';
  text?: string;
  limit?: number;
  offset?: number;
}

export interface ProfileRecord {
  id: string;
  name: string;
  active: boolean;
  payload: unknown;
}

export interface RetentionPolicy {
  observationDays: number;
  transitionDays: number;
  alertDays: number;
}

export interface Storage {
  // --- lifecycle ---
  init(): void;
  close(): void;

  // --- config: products ---
  upsertProduct(p: Product): void;
  deleteProduct(id: string): void;
  listProducts(): Product[];
  getProduct(id: string): Product | undefined;

  // --- config: platforms ---
  setPlatformSettings(id: PlatformId, s: PlatformSettings): void;
  getPlatformSettings(id: PlatformId): PlatformSettings | undefined;
  listPlatformSettings(): Record<string, PlatformSettings>;

  // --- config: locations ---
  upsertLocation(l: Location): void;
  deleteLocation(pincode: string): void;
  listLocations(): Location[];

  // --- profiles ---
  upsertProfile(p: ProfileRecord): void;
  deleteProfile(id: string): void;
  listProfiles(): ProfileRecord[];

  // --- targets ---
  upsertTarget(t: Target): void;
  deleteTarget(id: string): void;
  listTargets(): Target[];
  saveTargetState(t: Target): void;

  // --- observations / transitions / alerts (engine writes) ---
  recordObservation(targetId: string, obs: Observation): void;
  commitTransition(
    transition: Transition,
    alert: Alert | undefined,
    deliveries: DeliveryOutcome[] | undefined,
    edgeKey: string | undefined,
  ): void;
  loadDedupKeys(): string[];
  saveResolution(targetId: string, ref: { url?: string; platformRef?: string }): void;
  getResolution(targetId: string): { url?: string; platformRef?: string } | undefined;

  // --- history & events ---
  recordEvent(e: EventRecord): void;
  queryTransitions(q: HistoryQuery): Transition[];
  queryAlerts(q: HistoryQuery): Alert[];
  queryEvents(q: HistoryQuery): EventRecord[];

  // --- settings kv ---
  setSetting(key: string, value: unknown): void;
  getSetting<T>(key: string): T | undefined;

  // --- retention ---
  runRetention(policy: RetentionPolicy, now: number): { observationsPruned: number };
}
