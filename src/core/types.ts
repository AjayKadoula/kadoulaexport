/**
 * Domain model for Stock Sentinel.
 *
 * This module is pure: it imports nothing and performs no I/O. Everything the
 * engine needs from the outside world is expressed as a "port" interface at the
 * bottom of this file. That is what keeps the reliability-critical logic
 * (state machine, scheduler, alert decisions) deterministically testable.
 */

// ---------------------------------------------------------------------------
// Availability model — the nine states are never collapsed. See
// docs/01-requirements.md §3.5.
// ---------------------------------------------------------------------------

export enum AvailabilityState {
  /** Purchasable now at this location. */
  AVAILABLE = 'AVAILABLE',
  /** Listed, deliverable area, but no stock. */
  OUT_OF_STOCK = 'OUT_OF_STOCK',
  /** Listed, but not deliverable/serviceable to this pincode. */
  UNAVAILABLE_IN_AREA = 'UNAVAILABLE_IN_AREA',
  /** Announced, not yet orderable. */
  COMING_SOON = 'COMING_SOON',
  /** Orderable as a pre-order (not immediate stock). */
  PREORDER = 'PREORDER',
  /** Platform marks it temporarily off (e.g. Amazon "Currently unavailable"). */
  TEMPORARILY_UNAVAILABLE = 'TEMPORARILY_UNAVAILABLE',
  /** Product cannot be found on this platform/store catalog. */
  NOT_LISTED = 'NOT_LISTED',
  /** Page fetched but signals were ambiguous. Never guessed into a real state. */
  UNKNOWN = 'UNKNOWN',
  /** The check itself failed (network, block, parse failure). */
  ERROR = 'ERROR',
}

/**
 * The subset of states that describe the real commercial condition of a
 * product. UNKNOWN and ERROR are *overlays* — they describe our knowledge, not
 * the world — so they never overwrite the last known commercial state.
 */
export const COMMERCIAL_STATES: ReadonlySet<AvailabilityState> = new Set([
  AvailabilityState.AVAILABLE,
  AvailabilityState.OUT_OF_STOCK,
  AvailabilityState.UNAVAILABLE_IN_AREA,
  AvailabilityState.COMING_SOON,
  AvailabilityState.PREORDER,
  AvailabilityState.TEMPORARILY_UNAVAILABLE,
  AvailabilityState.NOT_LISTED,
]);

export function isCommercialState(s: AvailabilityState): boolean {
  return COMMERCIAL_STATES.has(s);
}

/** States from which a transition to AVAILABLE is an alert-worthy "restock". */
export const RESTOCK_FROM_STATES: ReadonlySet<AvailabilityState> = new Set([
  AvailabilityState.OUT_OF_STOCK,
  AvailabilityState.TEMPORARILY_UNAVAILABLE,
  AvailabilityState.UNAVAILABLE_IN_AREA,
  AvailabilityState.NOT_LISTED,
  AvailabilityState.COMING_SOON,
  AvailabilityState.PREORDER,
  AvailabilityState.UNKNOWN,
]);

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

export interface Money {
  /** Amount in the currency's minor unit (paise for INR) to avoid float error. */
  readonly minor: number;
  readonly currency: string; // ISO 4217, e.g. "INR"
}

export function inr(rupees: number): Money {
  return { minor: Math.round(rupees * 100), currency: 'INR' };
}

export function formatMoney(m: Money | undefined): string {
  if (!m) return '—';
  const major = m.minor / 100;
  return `${m.currency === 'INR' ? '₹' : m.currency + ' '}${major.toLocaleString('en-IN', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  })}`;
}

// ---------------------------------------------------------------------------
// Signals & evidence — an Observation carries *why* it reached its verdict, so
// every alert is auditable and every misread is diagnosable.
// ---------------------------------------------------------------------------

export enum SignalKind {
  /** A strong positive purchasable indicator (enabled buy button, InStock). */
  BUY_CONTROL_PRESENT = 'BUY_CONTROL_PRESENT',
  BUY_CONTROL_ABSENT = 'BUY_CONTROL_ABSENT',
  /** Structured data availability, e.g. schema.org InStock/OutOfStock. */
  STRUCTURED_IN_STOCK = 'STRUCTURED_IN_STOCK',
  STRUCTURED_OUT_OF_STOCK = 'STRUCTURED_OUT_OF_STOCK',
  /** Explicit API boolean/quantity truth signal. */
  API_IN_STOCK = 'API_IN_STOCK',
  API_OUT_OF_STOCK = 'API_OUT_OF_STOCK',
  /** Availability text on the page. */
  TEXT_AVAILABLE = 'TEXT_AVAILABLE',
  TEXT_OUT_OF_STOCK = 'TEXT_OUT_OF_STOCK',
  TEXT_AREA_UNAVAILABLE = 'TEXT_AREA_UNAVAILABLE',
  TEXT_COMING_SOON = 'TEXT_COMING_SOON',
  TEXT_PREORDER = 'TEXT_PREORDER',
  TEXT_TEMPORARILY_UNAVAILABLE = 'TEXT_TEMPORARILY_UNAVAILABLE',
  /** Product absent from catalog/search for this store. */
  NOT_FOUND_IN_CATALOG = 'NOT_FOUND_IN_CATALOG',
  /** Price observed. */
  PRICE_PRESENT = 'PRICE_PRESENT',
  /** Anti-bot / empty-stub / block signature — forces UNKNOWN, never OOS. */
  AMBIGUOUS_EMPTY = 'AMBIGUOUS_EMPTY',
  BLOCK_SIGNATURE = 'BLOCK_SIGNATURE',
  LOGIN_WALL = 'LOGIN_WALL',
}

export interface Signal {
  readonly kind: SignalKind;
  /** Where the signal came from, for auditing (selector, field path, url). */
  readonly source: string;
  /** Optional human-readable detail, e.g. the matched text. */
  readonly detail?: string;
}

// ---------------------------------------------------------------------------
// Observation — the atomic result of one check.
// ---------------------------------------------------------------------------

export type FetchVia = 'browser' | 'browser-api' | 'http' | 'ssr' | 'fake';

export interface Observation {
  readonly state: AvailabilityState;
  /** 0..1 — how sure we are of `state` given signal agreement. */
  readonly confidence: number;
  readonly signals: readonly Signal[];
  readonly price?: Money;
  readonly url?: string;
  readonly fetchedVia: FetchVia;
  /** Epoch ms. Always supplied by the injected Clock, never Date.now(). */
  readonly at: number;
  /** True when this observation was produced by a confirmation re-check. */
  readonly confirming?: boolean;
}

// ---------------------------------------------------------------------------
// Products, platforms, locations, targets
// ---------------------------------------------------------------------------

export type MonitorMode = 'keyword' | 'url';

export interface ProductMatchRules {
  /** All of these substrings must appear in a candidate title (case-insensitive). */
  readonly mustInclude?: readonly string[];
  /** None of these may appear. */
  readonly mustExclude?: readonly string[];
  /** Alert only at/under this price (minor units). */
  readonly maxPriceMinor?: number;
}

export interface Product {
  readonly id: string;
  readonly name: string;
  readonly mode: MonitorMode;
  /** For keyword mode: search terms per platform (or one shared term). */
  readonly keywords?: readonly string[];
  readonly rules?: ProductMatchRules;
  readonly group?: string;
  readonly enabled: boolean;
  /** For url mode: platformId -> product URL. */
  readonly urls?: Readonly<Record<string, string>>;
}

export type PlatformId =
  | 'amazon'
  | 'flipkart'
  | 'blinkit'
  | 'zepto'
  | 'instamart'
  | 'bigbasket';

export interface PlatformSettings {
  readonly enabled: boolean;
  /** Override the manifest default interval (seconds), floored by the manifest min. */
  readonly intervalOverrideS?: number;
  readonly useAuthenticatedSession: boolean;
}

export interface Location {
  readonly pincode: string;
  readonly label?: string;
  readonly enabled: boolean;
}

/** Health overlay independent of commercial state. */
export type TargetHealth = 'ok' | 'unstable' | 'degraded' | 'needs-login' | 'blocked' | 'offline';

export interface Target {
  readonly id: string;
  readonly productId: string;
  readonly platformId: PlatformId;
  readonly pincode: string;
  enabled: boolean;
  // Schedule state
  intervalS: number;
  nextDueAt: number;
  backoffLevel: number;
  // Machine state
  state: AvailabilityState;
  /** Last known *commercial* state (survives UNKNOWN/ERROR overlays). */
  lastCommercialState: AvailabilityState;
  stateSince: number;
  lastConfirmedAt: number;
  lastCheckedAt: number;
  consecutiveErrors: number;
  /** Count of AVAILABLE observations awaiting confirmation. */
  pendingAvailableConfirms: number;
  flapCount: number;
  flapWindowStart: number;
  volatileCooldownUntil: number;
  health: TargetHealth;
  lastPrice?: Money;
  /** Price that accompanied the last alert/transition; basis for price-change. */
  priceAtLastAlert?: Money;
}

// ---------------------------------------------------------------------------
// Transitions & alerts
// ---------------------------------------------------------------------------

export type TransitionReason =
  | 'restock'
  | 'listing-appeared'
  | 'preorder-open'
  | 'launch'
  | 'stock-lost'
  | 'went-temporarily-unavailable'
  | 'area-serviceable'
  | 'price-change'
  | 'info'
  | 'volatile-stock';

export interface Transition {
  readonly id: string;
  readonly targetId: string;
  readonly at: number;
  readonly from: AvailabilityState;
  readonly to: AvailabilityState;
  readonly reason: TransitionReason;
  /** Whether this transition warranted an alert. */
  readonly alertWorthy: boolean;
  readonly observation: Observation;
}

export type ConfidenceLevel = 'high' | 'medium' | 'low';

export interface Alert {
  readonly id: string;
  readonly transitionId: string;
  readonly targetId: string;
  readonly at: number;
  readonly productName: string;
  readonly platformId: PlatformId;
  readonly pincode: string;
  readonly state: AvailabilityState;
  readonly reason: TransitionReason;
  readonly price?: Money;
  readonly url?: string;
  readonly confidence: number;
  readonly confidenceLevel: ConfidenceLevel;
}

export type AlertChannelName = 'desktop' | 'sound' | 'email' | 'whatsapp';

export interface DeliveryOutcome {
  readonly channel: AlertChannelName;
  readonly status: 'sent' | 'failed' | 'skipped';
  readonly attempts: number;
  readonly error?: string;
  readonly at: number;
}

// ---------------------------------------------------------------------------
// Adapter contract (see docs/02-architecture.md §2.1)
// ---------------------------------------------------------------------------

export type LocationStrategy =
  | 'session-glow' // Amazon: address-change handshake bound to session
  | 'widget' // Flipkart: on-page pincode widget
  | 'latlon-header' // Blinkit: stateless lat/lon per request
  | 'store-id' // Zepto: resolve store_id, echo as header
  | 'store-cookie'; // Instamart / BigBasket: location cookies -> store/sa_ids

export interface PlatformManifest {
  readonly id: PlatformId;
  readonly name: string;
  readonly runtime: 'browser' | 'browser-api' | 'http';
  readonly locationStrategy: LocationStrategy;
  readonly guestBrowsingWorks: boolean;
  /** Minimum seconds between requests to this platform (politeness floor). */
  readonly minSpacingS: number;
  /** Default per-target interval seconds. */
  readonly defaultIntervalS: number;
  /** True if reaching AVAILABLE should always require a confirmation re-check. */
  readonly alwaysConfirmAvailable: boolean;
  readonly productUrlPattern?: string;
}

export interface SearchQuery {
  readonly text: string;
  readonly rules?: ProductMatchRules;
}

export interface CandidateProduct {
  readonly title: string;
  readonly url: string;
  /** Platform-native id (ASIN, pid, prid, pvid, product_id, itemId). */
  readonly platformRef: string;
  readonly price?: Money;
  /** Availability if the search result already exposes it. */
  readonly state?: AvailabilityState;
}

export interface ResolvedTarget {
  readonly productId: string;
  readonly platformId: PlatformId;
  readonly pincode: string;
  /** Direct URL or platform ref to check (from url mode or a prior search). */
  readonly url?: string;
  readonly platformRef?: string;
  readonly rules?: ProductMatchRules;
  /** For keyword mode with no resolved ref yet: the search text. */
  readonly keyword?: string;
}

export interface CheckContext {
  readonly pincode: string;
  readonly useAuthenticatedSession: boolean;
  /** Signals whether the engine wants this treated as a confirmation re-check. */
  readonly confirming?: boolean;
  readonly signal?: AbortSignal;
}

export interface SessionProbe {
  readonly loggedIn: boolean;
  readonly locationApplied: boolean;
  readonly healthy: boolean;
  readonly detail?: string;
}

export interface LocationResult {
  readonly applied: boolean;
  readonly serviceable: boolean;
  readonly detail?: string;
}

export interface PlatformAdapter {
  readonly manifest: PlatformManifest;
  search(q: SearchQuery, ctx: CheckContext): Promise<CandidateProduct[]>;
  check(target: ResolvedTarget, ctx: CheckContext): Promise<Observation>;
  probeSession(ctx: CheckContext): Promise<SessionProbe>;
  ensureLocation(pincode: string, ctx: CheckContext): Promise<LocationResult>;
}

// ---------------------------------------------------------------------------
// Ports the engine depends on (implemented in src/infra, src/alerts, tests)
// ---------------------------------------------------------------------------

export interface Clock {
  now(): number;
  /** Resolves after `ms` of *scheduled* time. Test clocks make this instant. */
  sleep(ms: number): Promise<void>;
}

export interface NetworkProbe {
  /** True if the machine currently has working outbound connectivity. */
  isOnline(): Promise<boolean>;
}

export interface AlertChannel {
  readonly name: AlertChannelName;
  readonly enabled: boolean;
  send(alert: Alert): Promise<void>;
}

export interface Logger {
  debug(msg: string, data?: unknown): void;
  info(msg: string, data?: unknown): void;
  warn(msg: string, data?: unknown): void;
  error(msg: string, data?: unknown): void;
  child(source: string): Logger;
}
