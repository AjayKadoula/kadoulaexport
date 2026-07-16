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
import { observationFrom } from '../base';
import { decodeEntities, titleMatchesQuery } from '../html';
import { extractAmazon } from './signals';

export const AMAZON_MANIFEST: PlatformManifest = {
  id: 'amazon',
  name: 'Amazon.in',
  runtime: 'browser', // full browser survives anti-bot; GLOW-pinned to a pincode
  locationStrategy: 'session-glow',
  guestBrowsingWorks: true,
  minSpacingS: 180, // Amazon is the most anti-bot-aggressive; be conservative
  defaultIntervalS: 900,
  alwaysConfirmAvailable: true,
  productUrlPattern: 'https://www.amazon.in/dp/{ASIN}',
};

export class AmazonAdapter implements PlatformAdapter {
  readonly manifest = AMAZON_MANIFEST;
  constructor(private readonly runtime: AdapterRuntime) {}

  async search(q: SearchQuery, ctx: CheckContext): Promise<CandidateProduct[]> {
    // Search-page monitoring is explicitly rejected in discovery (reorders by
    // location/sponsorship). We only use search to resolve an ASIN once.
    const raw = await this.runtime.search('amazon', q.text, ctx.pincode);
    if (raw.kind !== 'html' || raw.blocked) return [];
    const html = raw.html ?? '';
    const out: CandidateProduct[] = [];
    // Parse per result block: the title (img alt / aria-label) sits thousands
    // of characters after `data-asin` in real search HTML, so scan each block
    // up to the next result rather than a fixed short window.
    const blocks = html.split(/data-asin=["']/).slice(1);
    const seen = new Set<string>();
    for (const b of blocks) {
      if (out.length >= 10) break;
      const asin = b.slice(0, 10);
      if (!/^[A-Z0-9]{10}$/.test(asin) || seen.has(asin)) continue;
      const block = b.slice(0, 20000);
      const alt = /alt=["']([^"']{3,})["']/.exec(block);
      if (!alt) continue;
      const title = decodeEntities(alt[1]!).replace(/^Sponsored Ad\s*[-–—]\s*/i, '').trim();
      if (!title) continue;
      // Search pages lead with sponsored/related items; only accept results
      // that actually match the query.
      if (!titleMatchesQuery(title, q.text)) continue;
      seen.add(asin);
      out.push({
        title,
        url: `https://www.amazon.in/dp/${asin}`,
        platformRef: asin,
      });
    }
    return out;
  }

  async check(target: ResolvedTarget, ctx: CheckContext): Promise<Observation> {
    const raw = await this.runtime.loadProduct('amazon', target, ctx.pincode);
    return observationFrom(raw, extractAmazon, 0, 'browser', ctx.confirming);
  }

  async probeSession(ctx: CheckContext): Promise<SessionProbe> {
    return this.runtime.probeSession('amazon', ctx.pincode);
  }

  async ensureLocation(pincode: string, ctx: CheckContext): Promise<LocationResult> {
    return this.runtime.ensureLocation('amazon', pincode, ctx.useAuthenticatedSession);
  }
}
