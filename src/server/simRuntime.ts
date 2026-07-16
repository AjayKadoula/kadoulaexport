/**
 * A simulated AdapterRuntime for the local web showcase and offline demos. It
 * fabricates realistic per-platform responses whose stock state changes over
 * real time, so the dashboard shows live transitions and alerts WITHOUT making
 * any network request to a real platform. This is what makes the app runnable
 * and observable in an environment with no display and no live-site access.
 *
 * It is NOT used in production — the Electron build wires the real Playwright
 * runtime. It lives under src/server because that is the headless showcase.
 */

import { PlatformId } from '../core/types';
import { AdapterRuntime, RawContent } from '../adapters/runtime';
import { platformSearchUrl } from '../adapters/searchUrls';

export interface SimOptions {
  now: () => number;
  /** Seconds for a full out->in->out stock cycle (varied per target). */
  cyclePeriodS?: number;
}

export class SimulatedRuntime implements AdapterRuntime {
  constructor(private readonly opts: SimOptions) {}

  async ensureLocation() {
    return { applied: true, serviceable: true };
  }
  async probeSession() {
    return { loggedIn: false, locationApplied: true, healthy: true };
  }
  async search(): Promise<RawContent> {
    return { kind: 'json', json: {}, finalUrl: '' };
  }

  async loadProduct(platform: PlatformId, resolved: { url?: string; platformRef?: string; keyword?: string; productId?: string; pincode?: string }): Promise<RawContent> {
    const seed = hash(`${platform}:${resolved.url ?? resolved.platformRef ?? ''}`);
    const period = (this.opts.cyclePeriodS ?? 90) * 1000;
    const phase = (this.opts.now() + seed) % period;
    // In stock for a short window each cycle (~20%), to make restocks visible.
    const inStock = phase < period * 0.2;
    const price = 134900 - (seed % 5) * 1000;
    // Even though the stock data is simulated, the link the user can click
    // must be real: echo the configured product URL, else link to the
    // platform's search for the watched keyword. Never a fabricated URL.
    const finalUrl =
      resolved.url ??
      platformSearchUrl(platform, resolved.keyword ?? resolved.productId ?? 'product');
    return build(platform, inStock, price, finalUrl);
  }
}

function build(platform: PlatformId, inStock: boolean, price: number, finalUrl: string): RawContent {
  switch (platform) {
    case 'bigbasket': {
      const next = { props: { pageProps: { productDetails: { children: [{ availability: { avail_status: inStock ? '001' : '002', not_for_sale: false }, pricing: { discount: { prim_price: { sp: String(price) } } } }] } } } };
      return { kind: 'html', finalUrl, html: `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(next)}</script>` };
    }
    case 'blinkit':
      return { kind: 'json', finalUrl, json: { products: [{ name: 'X', prid: 1, inventory: inStock ? 3 : 0, is_sold_out: !inStock, price }] } };
    case 'zepto':
      return { kind: 'json', finalUrl, json: { data: { sections: [{ items: [{ availabilityStatus: inStock ? 'AVAILABLE' : 'OUT_OF_STOCK', outOfStock: !inStock, availableQuantity: inStock ? 2 : 0, sellingPrice: price * 100 }] }] } } };
    case 'instamart':
      return { kind: 'json', finalUrl, json: { data: { storeId: '1', widgets: [{ product: { variations: [{ inventory: { inStock }, price: { offerPrice: { units: price } } }] } }] } } };
    case 'flipkart':
    case 'amazon':
    default: {
      const ld = `<script type="application/ld+json">${JSON.stringify({ '@type': 'Product', offers: { '@type': 'Offer', availability: `https://schema.org/${inStock ? 'InStock' : 'OutOfStock'}` } })}</script>`;
      const body = inStock
        ? `<div id="availability">In stock</div><input id="add-to-cart-button"><span class="a-offscreen">₹${price}</span><div class="dyC4hf">₹${price}</div><button>Add to Cart</button>`
        : `<div id="availability">Currently unavailable</div><div>Currently out of stock</div>`;
      return { kind: 'html', finalUrl, html: `<html><body>${ld}${body}</body></html>` };
    }
  }
}

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  return Math.abs(h) % 100000;
}
