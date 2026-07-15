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
  Money,
} from '../../core/types';
import { AdapterRuntime } from '../runtime';
import { observationFrom } from '../base';
import { extractBigBasket, findProducts, parseNextData } from './signals';

export const BIGBASKET_MANIFEST: PlatformManifest = {
  id: 'bigbasket',
  name: 'BigBasket',
  runtime: 'browser', // Playwright seeds Akamai/csurftoken cookies, then SSR fetch
  locationStrategy: 'store-cookie',
  guestBrowsingWorks: true,
  minSpacingS: 90,
  defaultIntervalS: 600,
  alwaysConfirmAvailable: false, // explicit avail_status is high-confidence
  productUrlPattern: 'https://www.bigbasket.com/pd/{id}/{slug}/',
};

export class BigBasketAdapter implements PlatformAdapter {
  readonly manifest = BIGBASKET_MANIFEST;
  constructor(private readonly runtime: AdapterRuntime) {}

  async search(q: SearchQuery, ctx: CheckContext): Promise<CandidateProduct[]> {
    const raw = await this.runtime.search('bigbasket', q.text, ctx.pincode);
    if (raw.blocked || raw.empty) return [];
    const nextData = raw.kind === 'json' ? raw.json : parseNextData(raw.html ?? '');
    const products = findProducts(nextData);
    return products.slice(0, 10).map((p) => {
      const desc = String((p as Record<string, unknown>)['desc'] ?? '');
      const absUrl = String((p as Record<string, unknown>)['absolute_url'] ?? '');
      const sp = deepGet(p, ['pricing', 'discount', 'prim_price', 'sp']);
      const price: Money | undefined =
        sp != null && Number.isFinite(parseFloat(String(sp)))
          ? { minor: Math.round(parseFloat(String(sp)) * 100), currency: 'INR' }
          : undefined;
      return {
        title: desc,
        url: absUrl.startsWith('http') ? absUrl : `https://www.bigbasket.com${absUrl}`,
        platformRef: String((p as Record<string, unknown>)['id'] ?? ''),
        price,
      };
    });
  }

  async check(target: ResolvedTarget, ctx: CheckContext): Promise<Observation> {
    const raw = await this.runtime.loadProduct('bigbasket', target, ctx.pincode);
    // `at: 0` is a placeholder; the engine stamps the real time from its clock.
    return observationFrom(raw, extractBigBasket, 0, 'ssr', ctx.confirming);
  }

  async probeSession(ctx: CheckContext): Promise<SessionProbe> {
    return this.runtime.probeSession('bigbasket', ctx.pincode);
  }

  async ensureLocation(pincode: string, ctx: CheckContext): Promise<LocationResult> {
    return this.runtime.ensureLocation('bigbasket', pincode, ctx.useAuthenticatedSession);
  }
}

function deepGet(obj: unknown, keys: string[]): unknown {
  let cur = obj;
  for (const k of keys) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}
