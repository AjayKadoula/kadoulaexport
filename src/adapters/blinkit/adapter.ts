import {
  CandidateProduct,
  CheckContext,
  LocationResult,
  Money,
  Observation,
  PlatformAdapter,
  PlatformManifest,
  ResolvedTarget,
  SearchQuery,
  SessionProbe,
} from '../../core/types';
import { AdapterRuntime } from '../runtime';
import { observationFrom, collect } from '../base';
import { extractBlinkit } from './signals';

export const BLINKIT_MANIFEST: PlatformManifest = {
  id: 'blinkit',
  name: 'Blinkit',
  runtime: 'browser-api', // Playwright-bootstrap, then poll internal JSON API
  locationStrategy: 'latlon-header',
  guestBrowsingWorks: true,
  minSpacingS: 90,
  defaultIntervalS: 600,
  alwaysConfirmAvailable: false,
  productUrlPattern: 'https://blinkit.com/prn/{slug}/prid/{id}',
};

export class BlinkitAdapter implements PlatformAdapter {
  readonly manifest = BLINKIT_MANIFEST;
  constructor(private readonly runtime: AdapterRuntime) {}

  async search(q: SearchQuery, ctx: CheckContext): Promise<CandidateProduct[]> {
    const raw = await this.runtime.search('blinkit', q.text, ctx.pincode);
    if (raw.kind !== 'json' || raw.blocked || raw.empty) return [];
    const nodes = collect(raw.json, (o) => 'name' in o && ('prid' in o || 'product_id' in o || 'id' in o));
    return nodes.slice(0, 10).map((n) => {
      const id = String(n['prid'] ?? n['product_id'] ?? n['id'] ?? '');
      const raw2 = n['price'] ?? n['mrp'];
      const price: Money | undefined =
        Number.isFinite(parseFloat(String(raw2)))
          ? { minor: Math.round(parseFloat(String(raw2)) * 100), currency: 'INR' }
          : undefined;
      return {
        title: String(n['name'] ?? ''),
        url: `https://blinkit.com/prn/x/prid/${id}`,
        platformRef: id,
        price,
      };
    });
  }

  async check(target: ResolvedTarget, ctx: CheckContext): Promise<Observation> {
    const raw = await this.runtime.loadProduct('blinkit', target, ctx.pincode);
    return observationFrom(raw, extractBlinkit, 0, 'browser-api', ctx.confirming);
  }

  async probeSession(ctx: CheckContext): Promise<SessionProbe> {
    return this.runtime.probeSession('blinkit', ctx.pincode);
  }

  async ensureLocation(pincode: string, ctx: CheckContext): Promise<LocationResult> {
    return this.runtime.ensureLocation('blinkit', pincode, ctx.useAuthenticatedSession);
  }
}
