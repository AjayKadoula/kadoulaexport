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
    const re = /data-asin=["']([A-Z0-9]{10})["'][\s\S]{0,400}?alt=["']([^"']+)["']/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) !== null && out.length < 10) {
      out.push({
        title: m[2]!,
        url: `https://www.amazon.in/dp/${m[1]}`,
        platformRef: m[1]!,
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
