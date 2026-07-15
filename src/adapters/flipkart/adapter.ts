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
      const url = m[1]!.startsWith('http') ? m[1]! : `https://www.flipkart.com${m[1]}`;
      out.push({ title: pid, url, platformRef: pid });
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
