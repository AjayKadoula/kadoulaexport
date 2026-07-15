/**
 * SQLite storage driver (production). Uses better-sqlite3 in WAL mode with a
 * single writer (the engine), which is exactly the crash-safe, single-process
 * profile a desktop app wants. Loaded lazily so environments without the native
 * module can fall back to the JSON driver.
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
  AvailabilityState,
} from '../../core/types';
import {
  EventRecord,
  HistoryQuery,
  ProfileRecord,
  RetentionPolicy,
  Storage,
} from './types';
import { edgeKey } from '../../core/dedup';

// Minimal structural type for the bits of better-sqlite3 we use, so this file
// typechecks without @types/better-sqlite3 installed.
interface SqliteStatement {
  run(...args: unknown[]): { changes: number };
  get(...args: unknown[]): unknown;
  all(...args: unknown[]): unknown[];
}
interface SqliteDb {
  prepare(sql: string): SqliteStatement;
  exec(sql: string): void;
  pragma(s: string): unknown;
  transaction<T extends (...a: unknown[]) => unknown>(fn: T): T;
  close(): void;
}

const MIGRATIONS: string[] = [
  `CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);`,
  `CREATE TABLE IF NOT EXISTS products (
     id TEXT PRIMARY KEY, name TEXT, mode TEXT, keywords TEXT, rules TEXT,
     group_name TEXT, enabled INTEGER, urls TEXT);`,
  `CREATE TABLE IF NOT EXISTS platforms (
     id TEXT PRIMARY KEY, enabled INTEGER, interval_override INTEGER, use_auth INTEGER);`,
  `CREATE TABLE IF NOT EXISTS locations (
     pincode TEXT PRIMARY KEY, label TEXT, enabled INTEGER);`,
  `CREATE TABLE IF NOT EXISTS profiles (
     id TEXT PRIMARY KEY, name TEXT, active INTEGER, payload TEXT);`,
  `CREATE TABLE IF NOT EXISTS targets (
     id TEXT PRIMARY KEY, product_id TEXT, platform_id TEXT, pincode TEXT,
     enabled INTEGER, interval_s INTEGER, next_due_at INTEGER, backoff_level INTEGER,
     state TEXT, last_commercial_state TEXT, state_since INTEGER, last_confirmed_at INTEGER,
     last_checked_at INTEGER, consecutive_errors INTEGER, pending_confirms INTEGER,
     flap_count INTEGER, flap_window_start INTEGER, volatile_cooldown_until INTEGER,
     health TEXT, last_price TEXT, price_at_last_alert TEXT);`,
  `CREATE TABLE IF NOT EXISTS resolutions (
     target_id TEXT PRIMARY KEY, url TEXT, platform_ref TEXT);`,
  `CREATE TABLE IF NOT EXISTS observations (
     id INTEGER PRIMARY KEY AUTOINCREMENT, target_id TEXT, at INTEGER, state TEXT,
     confidence REAL, price_minor INTEGER, currency TEXT, url TEXT, fetched_via TEXT,
     signals TEXT);`,
  `CREATE INDEX IF NOT EXISTS idx_obs_target_at ON observations(target_id, at);`,
  `CREATE TABLE IF NOT EXISTS transitions (
     id TEXT PRIMARY KEY, target_id TEXT, at INTEGER, from_state TEXT, to_state TEXT,
     reason TEXT, alert_worthy INTEGER);`,
  `CREATE INDEX IF NOT EXISTS idx_tr_at ON transitions(at);`,
  `CREATE TABLE IF NOT EXISTS alerts (
     id TEXT PRIMARY KEY, transition_id TEXT, target_id TEXT, at INTEGER, product_name TEXT,
     platform_id TEXT, pincode TEXT, state TEXT, reason TEXT, price_minor INTEGER,
     currency TEXT, url TEXT, confidence REAL, confidence_level TEXT);`,
  `CREATE INDEX IF NOT EXISTS idx_al_at ON alerts(at);`,
  `CREATE TABLE IF NOT EXISTS alert_deliveries (
     alert_id TEXT, channel TEXT, status TEXT, attempts INTEGER, error TEXT, at INTEGER);`,
  `CREATE TABLE IF NOT EXISTS dedup (edge_key TEXT PRIMARY KEY, at INTEGER);`,
  `CREATE TABLE IF NOT EXISTS events (
     id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER, kind TEXT, level TEXT,
     source TEXT, message TEXT, data TEXT);`,
  `CREATE INDEX IF NOT EXISTS idx_ev_at ON events(at);`,
  `CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);`,
];

function j(v: unknown): string | null {
  return v === undefined ? null : JSON.stringify(v);
}
function pj<T>(s: unknown): T | undefined {
  if (typeof s !== 'string' || s === '') return undefined;
  return JSON.parse(s) as T;
}

export class SqliteStorage implements Storage {
  private db!: SqliteDb;

  constructor(private readonly filePath: string) {}

  init(): void {
    // Lazy require so the JSON driver can be used where the native module isn't.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Database = require('better-sqlite3') as new (p: string) => SqliteDb;
    this.db = new Database(this.filePath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('foreign_keys = ON');
    for (const m of MIGRATIONS) this.db.exec(m);
    const row = this.db.prepare('SELECT version FROM schema_version').get() as
      | { version: number }
      | undefined;
    if (!row) {
      this.db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(MIGRATIONS.length);
    }
  }

  close(): void {
    this.db?.close();
  }

  // --- products ---
  upsertProduct(p: Product): void {
    this.db
      .prepare(
        `INSERT INTO products (id,name,mode,keywords,rules,group_name,enabled,urls)
         VALUES (?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET name=excluded.name, mode=excluded.mode,
           keywords=excluded.keywords, rules=excluded.rules, group_name=excluded.group_name,
           enabled=excluded.enabled, urls=excluded.urls`,
      )
      .run(p.id, p.name, p.mode, j(p.keywords), j(p.rules), p.group ?? null, p.enabled ? 1 : 0, j(p.urls));
  }
  deleteProduct(id: string): void {
    this.db.prepare('DELETE FROM products WHERE id=?').run(id);
  }
  listProducts(): Product[] {
    return (this.db.prepare('SELECT * FROM products').all() as any[]).map(rowToProduct);
  }
  getProduct(id: string): Product | undefined {
    const r = this.db.prepare('SELECT * FROM products WHERE id=?').get(id) as any;
    return r ? rowToProduct(r) : undefined;
  }

  // --- platforms ---
  setPlatformSettings(id: PlatformId, s: PlatformSettings): void {
    this.db
      .prepare(
        `INSERT INTO platforms (id,enabled,interval_override,use_auth) VALUES (?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET enabled=excluded.enabled,
           interval_override=excluded.interval_override, use_auth=excluded.use_auth`,
      )
      .run(id, s.enabled ? 1 : 0, s.intervalOverrideS ?? null, s.useAuthenticatedSession ? 1 : 0);
  }
  getPlatformSettings(id: PlatformId): PlatformSettings | undefined {
    const r = this.db.prepare('SELECT * FROM platforms WHERE id=?').get(id) as any;
    return r ? rowToPlatform(r) : undefined;
  }
  listPlatformSettings(): Record<string, PlatformSettings> {
    const out: Record<string, PlatformSettings> = {};
    for (const r of this.db.prepare('SELECT * FROM platforms').all() as any[]) {
      out[r.id] = rowToPlatform(r);
    }
    return out;
  }

  // --- locations ---
  upsertLocation(l: Location): void {
    this.db
      .prepare(
        `INSERT INTO locations (pincode,label,enabled) VALUES (?,?,?)
         ON CONFLICT(pincode) DO UPDATE SET label=excluded.label, enabled=excluded.enabled`,
      )
      .run(l.pincode, l.label ?? null, l.enabled ? 1 : 0);
  }
  deleteLocation(pincode: string): void {
    this.db.prepare('DELETE FROM locations WHERE pincode=?').run(pincode);
  }
  listLocations(): Location[] {
    return (this.db.prepare('SELECT * FROM locations').all() as any[]).map((r) => ({
      pincode: r.pincode,
      label: r.label ?? undefined,
      enabled: !!r.enabled,
    }));
  }

  // --- profiles ---
  upsertProfile(p: ProfileRecord): void {
    this.db
      .prepare(
        `INSERT INTO profiles (id,name,active,payload) VALUES (?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET name=excluded.name, active=excluded.active, payload=excluded.payload`,
      )
      .run(p.id, p.name, p.active ? 1 : 0, j(p.payload));
  }
  deleteProfile(id: string): void {
    this.db.prepare('DELETE FROM profiles WHERE id=?').run(id);
  }
  listProfiles(): ProfileRecord[] {
    return (this.db.prepare('SELECT * FROM profiles').all() as any[]).map((r) => ({
      id: r.id,
      name: r.name,
      active: !!r.active,
      payload: pj(r.payload),
    }));
  }

  // --- targets ---
  upsertTarget(t: Target): void {
    this.saveTargetState(t);
  }
  deleteTarget(id: string): void {
    this.db.prepare('DELETE FROM targets WHERE id=?').run(id);
  }
  listTargets(): Target[] {
    return (this.db.prepare('SELECT * FROM targets').all() as any[]).map(rowToTarget);
  }
  saveTargetState(t: Target): void {
    this.db
      .prepare(
        `INSERT INTO targets (id,product_id,platform_id,pincode,enabled,interval_s,next_due_at,
           backoff_level,state,last_commercial_state,state_since,last_confirmed_at,last_checked_at,
           consecutive_errors,pending_confirms,flap_count,flap_window_start,volatile_cooldown_until,
           health,last_price,price_at_last_alert)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET enabled=excluded.enabled, interval_s=excluded.interval_s,
           next_due_at=excluded.next_due_at, backoff_level=excluded.backoff_level, state=excluded.state,
           last_commercial_state=excluded.last_commercial_state, state_since=excluded.state_since,
           last_confirmed_at=excluded.last_confirmed_at, last_checked_at=excluded.last_checked_at,
           consecutive_errors=excluded.consecutive_errors, pending_confirms=excluded.pending_confirms,
           flap_count=excluded.flap_count, flap_window_start=excluded.flap_window_start,
           volatile_cooldown_until=excluded.volatile_cooldown_until, health=excluded.health,
           last_price=excluded.last_price, price_at_last_alert=excluded.price_at_last_alert`,
      )
      .run(
        t.id, t.productId, t.platformId, t.pincode, t.enabled ? 1 : 0, t.intervalS, t.nextDueAt,
        t.backoffLevel, t.state, t.lastCommercialState, t.stateSince, t.lastConfirmedAt, t.lastCheckedAt,
        t.consecutiveErrors, t.pendingAvailableConfirms, t.flapCount, t.flapWindowStart,
        t.volatileCooldownUntil, t.health, j(t.lastPrice), j(t.priceAtLastAlert),
      );
  }

  // --- observations / transitions / alerts ---
  recordObservation(targetId: string, obs: Observation): void {
    this.db
      .prepare(
        `INSERT INTO observations (target_id,at,state,confidence,price_minor,currency,url,fetched_via,signals)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        targetId, obs.at, obs.state, obs.confidence, obs.price?.minor ?? null,
        obs.price?.currency ?? null, obs.url ?? null, obs.fetchedVia, j(obs.signals),
      );
  }

  commitTransition(
    transition: Transition,
    alert: Alert | undefined,
    deliveries: DeliveryOutcome[] | undefined,
    edge: string | undefined,
  ): void {
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT OR REPLACE INTO transitions (id,target_id,at,from_state,to_state,reason,alert_worthy)
           VALUES (?,?,?,?,?,?,?)`,
        )
        .run(
          transition.id, transition.targetId, transition.at, transition.from, transition.to,
          transition.reason, transition.alertWorthy ? 1 : 0,
        );
      if (alert) {
        this.db
          .prepare(
            `INSERT OR REPLACE INTO alerts (id,transition_id,target_id,at,product_name,platform_id,
               pincode,state,reason,price_minor,currency,url,confidence,confidence_level)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          )
          .run(
            alert.id, alert.transitionId, alert.targetId, alert.at, alert.productName, alert.platformId,
            alert.pincode, alert.state, alert.reason, alert.price?.minor ?? null,
            alert.price?.currency ?? null, alert.url ?? null, alert.confidence, alert.confidenceLevel,
          );
      }
      if (deliveries) {
        for (const d of deliveries) {
          this.db
            .prepare(
              `INSERT INTO alert_deliveries (alert_id,channel,status,attempts,error,at) VALUES (?,?,?,?,?,?)`,
            )
            .run(alert?.id ?? null, d.channel, d.status, d.attempts, d.error ?? null, d.at);
        }
      }
      if (edge) {
        this.db.prepare('INSERT OR IGNORE INTO dedup (edge_key,at) VALUES (?,?)').run(edge, transition.at);
      }
    });
    tx();
  }

  loadDedupKeys(): string[] {
    return (this.db.prepare('SELECT edge_key FROM dedup').all() as any[]).map((r) => r.edge_key);
  }

  saveResolution(targetId: string, ref: { url?: string; platformRef?: string }): void {
    this.db
      .prepare(
        `INSERT INTO resolutions (target_id,url,platform_ref) VALUES (?,?,?)
         ON CONFLICT(target_id) DO UPDATE SET url=excluded.url, platform_ref=excluded.platform_ref`,
      )
      .run(targetId, ref.url ?? null, ref.platformRef ?? null);
  }
  getResolution(targetId: string): { url?: string; platformRef?: string } | undefined {
    const r = this.db.prepare('SELECT * FROM resolutions WHERE target_id=?').get(targetId) as any;
    if (!r) return undefined;
    return { url: r.url ?? undefined, platformRef: r.platform_ref ?? undefined };
  }

  // --- history & events ---
  recordEvent(e: EventRecord): void {
    this.db
      .prepare('INSERT INTO events (at,kind,level,source,message,data) VALUES (?,?,?,?,?,?)')
      .run(e.at, e.kind, e.level, e.source, e.message, j(e.data));
  }

  queryTransitions(q: HistoryQuery): Transition[] {
    const { where, params } = buildWhere(q, 'transitions');
    const rows = this.db
      .prepare(`SELECT * FROM transitions ${where} ORDER BY at DESC LIMIT ? OFFSET ?`)
      .all(...params, q.limit ?? 200, q.offset ?? 0) as any[];
    return rows.map((r) => ({
      id: r.id,
      targetId: r.target_id,
      at: r.at,
      from: r.from_state as AvailabilityState,
      to: r.to_state as AvailabilityState,
      reason: r.reason,
      alertWorthy: !!r.alert_worthy,
      observation: {
        state: r.to_state,
        confidence: 0,
        signals: [],
        fetchedVia: 'fake',
        at: r.at,
      },
    }));
  }

  queryAlerts(q: HistoryQuery): Alert[] {
    const { where, params } = buildWhere(q, 'alerts');
    const rows = this.db
      .prepare(`SELECT * FROM alerts ${where} ORDER BY at DESC LIMIT ? OFFSET ?`)
      .all(...params, q.limit ?? 200, q.offset ?? 0) as any[];
    return rows.map((r) => ({
      id: r.id,
      transitionId: r.transition_id,
      targetId: r.target_id,
      at: r.at,
      productName: r.product_name,
      platformId: r.platform_id,
      pincode: r.pincode,
      state: r.state,
      reason: r.reason,
      price: r.price_minor != null ? { minor: r.price_minor, currency: r.currency } : undefined,
      url: r.url ?? undefined,
      confidence: r.confidence,
      confidenceLevel: r.confidence_level,
    }));
  }

  queryEvents(q: HistoryQuery): EventRecord[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (q.from) { clauses.push('at >= ?'); params.push(q.from); }
    if (q.to) { clauses.push('at <= ?'); params.push(q.to); }
    if (q.text) { clauses.push('message LIKE ?'); params.push(`%${q.text}%`); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db
      .prepare(`SELECT * FROM events ${where} ORDER BY at DESC LIMIT ? OFFSET ?`)
      .all(...params, q.limit ?? 200, q.offset ?? 0) as any[];
    return rows.map((r) => ({
      id: r.id,
      at: r.at,
      kind: r.kind,
      level: r.level,
      source: r.source,
      message: r.message,
      data: pj(r.data),
    }));
  }

  // --- settings ---
  setSetting(key: string, value: unknown): void {
    this.db
      .prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
      .run(key, j(value));
  }
  getSetting<T>(key: string): T | undefined {
    const r = this.db.prepare('SELECT value FROM settings WHERE key=?').get(key) as any;
    return r ? (pj<T>(r.value) as T) : undefined;
  }

  // --- retention ---
  runRetention(policy: RetentionPolicy, now: number): { observationsPruned: number } {
    const cutObs = now - policy.observationDays * 86_400_000;
    const res = this.db.prepare('DELETE FROM observations WHERE at < ?').run(cutObs);
    return { observationsPruned: res.changes };
  }
}

function buildWhere(q: HistoryQuery, table: string): { where: string; params: unknown[] } {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (q.from) { clauses.push('at >= ?'); params.push(q.from); }
  if (q.to) { clauses.push('at <= ?'); params.push(q.to); }
  if (q.targetId) { clauses.push('target_id = ?'); params.push(q.targetId); }
  if (q.platformId && table === 'alerts') { clauses.push('platform_id = ?'); params.push(q.platformId); }
  if (q.text && table === 'alerts') { clauses.push('product_name LIKE ?'); params.push(`%${q.text}%`); }
  return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
}

function rowToProduct(r: any): Product {
  return {
    id: r.id,
    name: r.name,
    mode: r.mode,
    keywords: pj(r.keywords),
    rules: pj(r.rules),
    group: r.group_name ?? undefined,
    enabled: !!r.enabled,
    urls: pj(r.urls),
  };
}
function rowToPlatform(r: any): PlatformSettings {
  return {
    enabled: !!r.enabled,
    intervalOverrideS: r.interval_override ?? undefined,
    useAuthenticatedSession: !!r.use_auth,
  };
}
function rowToTarget(r: any): Target {
  return {
    id: r.id,
    productId: r.product_id,
    platformId: r.platform_id,
    pincode: r.pincode,
    enabled: !!r.enabled,
    intervalS: r.interval_s,
    nextDueAt: r.next_due_at,
    backoffLevel: r.backoff_level,
    state: r.state,
    lastCommercialState: r.last_commercial_state,
    stateSince: r.state_since,
    lastConfirmedAt: r.last_confirmed_at,
    lastCheckedAt: r.last_checked_at,
    consecutiveErrors: r.consecutive_errors,
    pendingAvailableConfirms: r.pending_confirms,
    flapCount: r.flap_count,
    flapWindowStart: r.flap_window_start,
    volatileCooldownUntil: r.volatile_cooldown_until,
    health: r.health,
    lastPrice: pj(r.last_price),
    priceAtLastAlert: pj(r.price_at_last_alert),
  };
}

export { edgeKey };
