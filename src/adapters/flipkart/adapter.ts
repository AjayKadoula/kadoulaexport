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
import { extractFlipkart } from './signals';

export const FLIPKART_MANIFEST: PlatformManifest = {
  id: 'flipkart',
  name: 'Flipkart',
  runtime: 'browser',
  locationStrategy: 'widget',
  guestBrowsingWorks: true,
  minSpacingS: 120,
  defaultIntervalS: 600,
  alwaysConfirmAvailable: true,
  productUrlPattern: 'https://www.flipkart.com/{slug}/p/itm?pid={PID}',
};

export class FlipkartAdapter implements PlatformAdapter {
  readonly manifest = FLIPKART_MANIFEST;
  constructor(private readonly runtime: AdapterRuntime) {}

  async search(q: SearchQuery, ctx: CheckContext): Promise<CandidateProduct[]> {
    const raw = await this.runtime.search('flipkart', q.text, ctx.pincode);
    if (raw.kind !== 'html' || raw.blocked) return [];
    const html = raw.html ?? '';
    const out: CandidateProduct[] = [];
    const re = /href=["']([^"']*\/p\/itm[^"']*pid=([A-Z0-9]+)[^"']*)["']/gi;
    let m: RegExpExecArray | null;
    const seen = new Set<string>();
    while ((m = re.exec(html)) !== null && out.length < 10) {
      const pid = m[2]!;
      if (seen.has(pid)) continue;
      seen.add(pid);
      // Hrefs scraped from raw HTML carry entity-encoded separators (&amp;);
      // decode so the link opens with real query params.
      const href = decodeEntities(m[1]!);
      const url = href.startsWith('http') ? href : `https://www.flipkart.com${href}`;
      // The product-page slug is the only title present near the href; use it
      // so candidate-matching rules (mustInclude/mustExclude) see real words.
      const slug = /flipkart\.com\/([^/?]+)\/p\/itm/i.exec(url)?.[1];
      const title = slug ? slug.replace(/-/g, ' ') : pid;
      // Skip sponsored/cross-sell cards that don't match the query.
      if (slug && !titleMatchesQuery(title, q.text)) continue;
      out.push({ title, url, platformRef: pid });
    }
    return out;
  }

  async check(target: ResolvedTarget, ctx: CheckContext): Promise<Observation> {
    const raw = await this.runtime.loadProduct('flipkart', target, ctx.pincode);
    return observationFrom(raw, extractFlipkart, 0, 'browser', ctx.confirming);
  }

  async probeSession(ctx: CheckContext): Promise<SessionProbe> {
    return this.runtime.probeSession('flipkart', ctx.pincode);
  }

  async ensureLocation(pincode: string, ctx: CheckContext): Promise<LocationResult> {
    return this.runtime.ensureLocation('flipkart', pincode, ctx.useAuthenticatedSession);
  }
}
