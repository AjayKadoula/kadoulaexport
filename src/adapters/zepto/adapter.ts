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
import { anchorsWithInner, anchorTitle, firstRupeeMinor, titleMatchesQuery } from '../html';
import { extractZepto } from './signals';

export const ZEPTO_MANIFEST: PlatformManifest = {
  id: 'zepto',
  name: 'Zepto',
  runtime: 'browser-api',
  locationStrategy: 'store-id',
  guestBrowsingWorks: true,
  minSpacingS: 90,
  defaultIntervalS: 600,
  alwaysConfirmAvailable: false,
  productUrlPattern: 'https://www.zepto.com/pn/{slug}/pvid/{id}',
};

export class ZeptoAdapter implements PlatformAdapter {
  readonly manifest = ZEPTO_MANIFEST;
  constructor(private readonly runtime: AdapterRuntime) {}

  async search(q: SearchQuery, ctx: CheckContext): Promise<CandidateProduct[]> {
    const raw = await this.runtime.search('zepto', q.text, ctx.pincode);
    if (raw.blocked || raw.empty) return [];
    // Rendered search page (production runtime): product cards are anchors to
    // /pn/<slug>/pvid/<uuid> — the canonical, openable product URL (the slug is
    // real, and Zepto resolves by pvid regardless).
    if (raw.kind === 'html') {
      const out: CandidateProduct[] = [];
      for (const a of anchorsWithInner(raw.html ?? '')) {
        const m = /\/pn\/([^/?"']+)\/pvid\/([a-f0-9-]{36})/i.exec(a.href);
        if (!m) continue;
        if (out.some((c) => c.platformRef === m[2])) continue;
        const title = anchorTitle(a.inner);
        if (!title) continue;
        // Rendered pages mix in trending/recommendation cards; only accept
        // anchors that actually match the query.
        if (!titleMatchesQuery(`${title} ${m[1]!.replace(/-/g, ' ')}`, q.text)) continue;
        const minor = firstRupeeMinor(a.inner);
        out.push({
          title,
          url: `https://www.zepto.com/pn/${m[1]}/pvid/${m[2]}`,
          platformRef: m[2]!,
          price: minor !== undefined ? { minor, currency: 'INR' } : undefined,
        });
        if (out.length >= 10) break;
      }
      return out;
    }
    const nodes = collect(raw.json, (o) => 'productVariant' in o || ('name' in o && 'availabilityStatus' in o));
    return nodes.slice(0, 10).map((n) => {
      const variant = (n['productVariant'] as Record<string, unknown>) ?? n;
      const id = String(variant['id'] ?? n['id'] ?? '');
      const rawP = n['sellingPrice'] ?? n['mrp'];
      const num = parseFloat(String(rawP));
      const price: Money | undefined = Number.isFinite(num)
        ? { minor: Number.isInteger(num) && num >= 1000 ? num : Math.round(num * 100), currency: 'INR' }
        : undefined;
      return {
        title: String((n['product'] as Record<string, unknown>)?.['name'] ?? n['name'] ?? ''),
        url: `https://www.zepto.com/pn/x/pvid/${id}`,
        platformRef: id,
        price,
      };
    });
  }

  async check(target: ResolvedTarget, ctx: CheckContext): Promise<Observation> {
    const raw = await this.runtime.loadProduct('zepto', target, ctx.pincode);
    return observationFrom(raw, extractZepto, 0, 'browser-api', ctx.confirming);
  }

  async probeSession(ctx: CheckContext): Promise<SessionProbe> {
    return this.runtime.probeSession('zepto', ctx.pincode);
  }

  async ensureLocation(pincode: string, ctx: CheckContext): Promise<LocationResult> {
    return this.runtime.ensureLocation('zepto', pincode, ctx.useAuthenticatedSession);
  }
}
