import {
  CandidateProduct,
  CheckContext,
  LocationResult,
  Observation,
  PlatformAdapter,
  PlatformManifest,
  ResolvedTarget,
  SearchQuery,
  SessionProbe,
} from '../../core/types';
import { AdapterRuntime } from '../runtime';
import { observationFrom, collect } from '../base';
import { platformSearchUrl } from '../searchUrls';
import { extractInstamart } from './signals';

export const INSTAMART_MANIFEST: PlatformManifest = {
  id: 'instamart',
  name: 'Swiggy Instamart',
  runtime: 'browser-api',
  locationStrategy: 'store-cookie',
  guestBrowsingWorks: true,
  minSpacingS: 120, // WAF-sensitive; keep it gentle
  defaultIntervalS: 600,
  alwaysConfirmAvailable: true, // extra caution given WAF-stub false-negative risk
};

export class InstamartAdapter implements PlatformAdapter {
  readonly manifest = INSTAMART_MANIFEST;
  constructor(private readonly runtime: AdapterRuntime) {}

  async search(q: SearchQuery, ctx: CheckContext): Promise<CandidateProduct[]> {
    const raw = await this.runtime.search('instamart', q.text, ctx.pincode);
    if (raw.kind !== 'json' || raw.blocked || raw.empty) return [];
    const nodes = collect(raw.json, (o) => 'itemId' in o || ('name' in o && 'variations' in o));
    return nodes.slice(0, 10).map((n) => {
      const title = String(n['name'] ?? n['display_name'] ?? '');
      return {
        title,
        // Instamart has no stable public product-page URL scheme; link to the
        // search for this exact item so the user always lands somewhere real.
        url: platformSearchUrl('instamart', title || q.text),
        platformRef: String(n['itemId'] ?? n['id'] ?? ''),
      };
    });
  }

  async check(target: ResolvedTarget, ctx: CheckContext): Promise<Observation> {
    const raw = await this.runtime.loadProduct('instamart', target, ctx.pincode);
    return observationFrom(raw, extractInstamart, 0, 'browser-api', ctx.confirming);
  }

  async probeSession(ctx: CheckContext): Promise<SessionProbe> {
    return this.runtime.probeSession('instamart', ctx.pincode);
  }

  async ensureLocation(pincode: string, ctx: CheckContext): Promise<LocationResult> {
    return this.runtime.ensureLocation('instamart', pincode, ctx.useAuthenticatedSession);
  }
}
