/**
 * Adapter runtime abstraction.
 *
 * Adapters do NOT talk to Playwright or HTTP directly. They ask an
 * `AdapterRuntime` for the raw content of a product page / search / API call at
 * a given location, and then run a *pure* signal extractor over it. This split
 * is deliberate:
 *   - The reliability-critical part (turning raw content into a 9-state verdict)
 *     is pure and exhaustively tested against fixtures.
 *   - The fragile part (browser navigation, cookies, location setting) lives
 *     behind this interface, has a real Playwright implementation and a fixture
 *     implementation for tests, and can change without touching detection logic.
 */

import {
  LocationResult,
  PlatformId,
  ResolvedTarget,
  SessionProbe,
} from '../core/types';

export interface RawContent {
  kind: 'html' | 'json';
  html?: string;
  json?: unknown;
  finalUrl: string;
  httpStatus?: number;
  /** 403/429/CAPTCHA/block-page detected by the runtime. */
  blocked?: boolean;
  /** Redirected to / gated by a login wall. */
  loginWall?: boolean;
  /** 200 but empty/placeholder body (e.g. Swiggy WAF stub). */
  empty?: boolean;
}

export interface AdapterRuntime {
  ensureLocation(platform: PlatformId, pincode: string, useAuth: boolean): Promise<LocationResult>;
  probeSession(platform: PlatformId, pincode: string): Promise<SessionProbe>;
  /** Load a resolved product's page/API content at a location. */
  loadProduct(platform: PlatformId, resolved: ResolvedTarget, pincode: string): Promise<RawContent>;
  /** Run a keyword search, returning content the adapter parses into candidates. */
  search(platform: PlatformId, query: string, pincode: string): Promise<RawContent>;
}

/**
 * Fixture runtime for tests: returns canned RawContent keyed by a lookup fn.
 * This is how we exercise adapters end-to-end without any network.
 */
export class FixtureRuntime implements AdapterRuntime {
  constructor(
    private readonly lookup: (
      op: 'product' | 'search',
      platform: PlatformId,
      key: string,
      pincode: string,
    ) => RawContent,
    private readonly location: LocationResult = { applied: true, serviceable: true },
    private readonly session: SessionProbe = { loggedIn: false, locationApplied: true, healthy: true },
  ) {}

  async ensureLocation(): Promise<LocationResult> {
    return this.location;
  }
  async probeSession(): Promise<SessionProbe> {
    return this.session;
  }
  async loadProduct(platform: PlatformId, resolved: ResolvedTarget, pincode: string): Promise<RawContent> {
    const key = resolved.url ?? resolved.platformRef ?? resolved.keyword ?? '';
    return this.lookup('product', platform, key, pincode);
  }
  async search(platform: PlatformId, query: string, pincode: string): Promise<RawContent> {
    return this.lookup('search', platform, query, pincode);
  }
}
