/**
 * Candidate/link construction tests. These pin the behaviour that produces the
 * user-facing product links: search parsing per adapter (modelled on real
 * rendered pages captured live in July 2026), URL entity-decoding, sim-runtime
 * link echoing, and alert URL precedence.
 */

import { describe, it, expect } from 'vitest';
import { AmazonAdapter } from '../src/adapters/amazon/adapter';
import { FlipkartAdapter } from '../src/adapters/flipkart/adapter';
import { ZeptoAdapter } from '../src/adapters/zepto/adapter';
import { BlinkitAdapter } from '../src/adapters/blinkit/adapter';
import { BigBasketAdapter } from '../src/adapters/bigbasket/adapter';
import { InstamartAdapter } from '../src/adapters/instamart/adapter';
import { FixtureRuntime, RawContent } from '../src/adapters/runtime';
import { SimulatedRuntime } from '../src/server/simRuntime';
import { platformSearchUrl } from '../src/adapters/searchUrls';
import { decodeEntities } from '../src/adapters/html';
import { buildAlert } from '../src/core/alertFactory';
import { AvailabilityState, Observation, Product, Target } from '../src/core/types';
import { newTarget } from '../src/core/target';

const CTX = { pincode: '560004', useAuthenticatedSession: false };

function searchRuntime(raw: RawContent): FixtureRuntime {
  return new FixtureRuntime(() => raw);
}

describe('amazon search parsing', () => {
  // Real pages put the img alt thousands of chars after data-asin; the parser
  // must scan the whole result block, skip non-ASIN blocks, dedup, and strip
  // the sponsored prefix.
  const filler = '<div class="pad">' + 'x'.repeat(1500) + '</div>';
  const html = `
    <div data-asin="" class="empty"></div>
    <div data-asin="B0FZSWZZW2">${filler}<img alt="Sponsored Ad - OnePlus 15R | 12GB+256GB | Charcoal Black"></div>
    <div data-asin="B0FZSWZZW2">${filler}<img alt="OnePlus 15R | 12GB+256GB | Charcoal Black"></div>
    <div data-asin="B0GRB3FBBB">${filler}<img alt="OnePlus Nord 6 | 8GB+256GB | Pitch Black"></div>`;

  it('extracts ASINs across large gaps, dedups, strips sponsored prefix, drops non-matching items', async () => {
    const adapter = new AmazonAdapter(searchRuntime({ kind: 'html', html, finalUrl: 'https://www.amazon.in/s?k=x' }));
    const out = await adapter.search({ text: 'Oneplus 15R' }, CTX);
    // The Nord 6 card does not match the query and must be filtered out —
    // resolving a foreign product would misreport availability.
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      title: 'OnePlus 15R | 12GB+256GB | Charcoal Black',
      url: 'https://www.amazon.in/dp/B0FZSWZZW2',
      platformRef: 'B0FZSWZZW2',
    });
  });

  it('returns nothing when blocked', async () => {
    const adapter = new AmazonAdapter(searchRuntime({ kind: 'html', html, finalUrl: '', blocked: true }));
    expect(await adapter.search({ text: 'x' }, CTX)).toHaveLength(0);
  });
});

describe('flipkart search parsing', () => {
  const href =
    '/vivo-t5x-5g-cyber-green-128-gb/p/itm7da8aa253e72b?pid=MOBHH69NM5ERRNFT&amp;lid=LSTMOB1&amp;marketplace=FLIPKART';
  const html = `<a href="${href}"><img alt="vivo T5x 5G"></a><a href="${href}">dup</a>`;

  it('decodes HTML entities in the href and titles from the slug', async () => {
    const adapter = new FlipkartAdapter(searchRuntime({ kind: 'html', html, finalUrl: 'https://www.flipkart.com/search?q=T5X' }));
    const out = await adapter.search({ text: 'T5X' }, CTX);
    expect(out).toHaveLength(1);
    expect(out[0]!.url).toBe(
      'https://www.flipkart.com/vivo-t5x-5g-cyber-green-128-gb/p/itm7da8aa253e72b?pid=MOBHH69NM5ERRNFT&lid=LSTMOB1&marketplace=FLIPKART',
    );
    expect(out[0]!.url).not.toContain('&amp;');
    expect(out[0]!.title).toBe('vivo t5x 5g cyber green 128 gb'); // slug words, usable by match rules
    expect(out[0]!.platformRef).toBe('MOBHH69NM5ERRNFT');
  });
});

describe('zepto search parsing (rendered page)', () => {
  const html = `
    <a href="/pn/motorola-g57-power-pantone-corsair-8gb-ram-128gb-storage/pvid/67dc173a-8981-4ef4-859f-b2869ad528c3">
      <img alt="Motorola g57 Power Pantone Corsair 8GB RAM 128GB Storage"><span>ADD</span><span>₹19,799</span><span>₹21999</span>
    </a>
    <a href="https://www.zepto.com/pn/motorola-g57-power-pantone-regatta-8gb-ram-128gb-storage/pvid/aebb90a8-04bd-4dd7-a095-f8633bb6bb2e">
      <img alt="Motorola g57 Power Pantone Regatta 8GB RAM 128GB Storage"><span>₹20099</span>
    </a>
    <a href="/no-product">not a product</a>`;

  it('builds canonical product URLs with real slugs, titles and prices', async () => {
    const adapter = new ZeptoAdapter(searchRuntime({ kind: 'html', html, finalUrl: 'https://www.zepto.com/search?query=G57%20Power' }));
    const out = await adapter.search({ text: 'G57 Power' }, CTX);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      title: 'Motorola g57 Power Pantone Corsair 8GB RAM 128GB Storage',
      url: 'https://www.zepto.com/pn/motorola-g57-power-pantone-corsair-8gb-ram-128gb-storage/pvid/67dc173a-8981-4ef4-859f-b2869ad528c3',
      platformRef: '67dc173a-8981-4ef4-859f-b2869ad528c3',
      price: { minor: 1979900, currency: 'INR' },
    });
  });

  it('still parses API-shaped JSON search content', async () => {
    const json = { data: { sections: [{ items: [{ name: 'G57 Power', availabilityStatus: 'AVAILABLE', id: 'abc', sellingPrice: 1979900 }] }] } };
    const adapter = new ZeptoAdapter(searchRuntime({ kind: 'json', json, finalUrl: '' }));
    const out = await adapter.search({ text: 'G57 Power' }, CTX);
    expect(out.length).toBeGreaterThan(0);
  });
});

describe('blinkit search parsing (rendered page)', () => {
  const html = `<a href="/prn/pepsi-can-330ml/prid/12345"><img alt="Pepsi Can 330ml"><span>₹40</span></a>`;

  it('builds canonical /prn/<slug>/prid/<id> URLs', async () => {
    const adapter = new BlinkitAdapter(searchRuntime({ kind: 'html', html, finalUrl: 'https://blinkit.com/s/?q=pepsi' }));
    const out = await adapter.search({ text: 'pepsi' }, CTX);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      title: 'Pepsi Can 330ml',
      url: 'https://blinkit.com/prn/pepsi-can-330ml/prid/12345',
      platformRef: '12345',
      price: { minor: 4000, currency: 'INR' },
    });
  });
});

describe('bigbasket search parsing', () => {
  it('falls back to rendered /pd/ anchors when __NEXT_DATA__ has no products', async () => {
    const html = `
      <script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{}}}</script>
      <a href="/pd/40364806/apple-iphone-17e-256gb-black-1-unit/?nc=cl-prod-list">AppleApple iPhone 17e (256GB, Black)<span>₹59,900</span></a>`;
    const adapter = new BigBasketAdapter(searchRuntime({ kind: 'html', html, finalUrl: 'https://www.bigbasket.com/ps/?q=iphone+17' }));
    const out = await adapter.search({ text: 'iphone 17' }, CTX);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      url: 'https://www.bigbasket.com/pd/40364806/apple-iphone-17e-256gb-black-1-unit/',
      platformRef: '40364806',
    });
    expect(out[0]!.title).toContain('iPhone 17e');
  });

  it('returns nothing when edge-blocked (Akamai 403)', async () => {
    const adapter = new BigBasketAdapter(searchRuntime({ kind: 'html', html: 'Access Denied', finalUrl: '', blocked: true, httpStatus: 403 }));
    expect(await adapter.search({ text: 'iphone 17' }, CTX)).toHaveLength(0);
  });
});

describe('instamart search candidates', () => {
  it('links to the instamart search page instead of an empty URL', async () => {
    const json = { data: { widgets: [{ itemId: 'IT123', name: 'PlayStation 5 Pro' }] } };
    const adapter = new InstamartAdapter(searchRuntime({ kind: 'json', json, finalUrl: '' }));
    const out = await adapter.search({ text: 'ps5 pro' }, CTX);
    expect(out.length).toBeGreaterThan(0);
    expect(out[0]!.url).toBe(platformSearchUrl('instamart', 'PlayStation 5 Pro'));
    expect(out[0]!.url).toContain('https://www.swiggy.com/instamart/search?query=');
  });
});

describe('simulated runtime link honesty', () => {
  const sim = new SimulatedRuntime({ now: () => 1000, cyclePeriodS: 60 });

  it('echoes a configured product URL as finalUrl', async () => {
    const raw = await sim.loadProduct('zepto', {
      productId: 'p', pincode: '122001',
      url: 'https://www.zepto.com/pn/real-slug/pvid/67dc173a-8981-4ef4-859f-b2869ad528c3',
    });
    expect(raw.finalUrl).toBe('https://www.zepto.com/pn/real-slug/pvid/67dc173a-8981-4ef4-859f-b2869ad528c3');
  });

  it('falls back to the platform search URL for keyword targets', async () => {
    const raw = await sim.loadProduct('amazon', {
      productId: 'p', pincode: '122001', keyword: 'iPhone 17 Pro Max',
    });
    expect(raw.finalUrl).toBe(platformSearchUrl('amazon', 'iPhone 17 Pro Max'));
  });
});

describe('alert URL precedence', () => {
  it('prefers the user-configured product URL over the fetch finalUrl', () => {
    const product: Product = {
      id: 'p1', name: 'iPhone 17', mode: 'url', enabled: true,
      urls: { amazon: 'https://www.amazon.in/dp/B0FZSWZZW2' },
    };
    const target: Target = newTarget({ id: 't1', productId: 'p1', platformId: 'amazon', pincode: '122001', intervalS: 600, now: 0 });
    const obs: Observation = {
      state: AvailabilityState.AVAILABLE, confidence: 0.95, signals: [],
      url: 'https://www.amazon.in/ref=some-redirect-junk', fetchedVia: 'browser', at: 1,
    };
    const alert = buildAlert({
      id: 'a1', product, target,
      transition: { id: 'tr1', targetId: 't1', from: AvailabilityState.OUT_OF_STOCK, to: AvailabilityState.AVAILABLE, reason: 'restock', alertWorthy: true, observation: obs, at: 1 },
    });
    expect(alert.url).toBe('https://www.amazon.in/dp/B0FZSWZZW2');
  });
});

describe('zepto product-page extraction (rendered /pn/…/pvid/… page)', () => {
  // Shapes verified against the live G57 Power page, July 2026.
  const inStockHtml = `<html><body>
    <div itemscope itemprop="offers" itemtype="http://schema.org/Offer">
      <span content="20599" itemprop="price"></span>
      <link href="http://schema.org/InStock" itemprop="availability">
    </div>
    <button>Add to Cart</button></body></html>`;
  const oosHtml = `<html><body>
    <div itemtype="http://schema.org/Offer">
      <span content="20599" itemprop="price"></span>
      <link href="http://schema.org/OutOfStock" itemprop="availability">
    </div><div>Notify Me</div></body></html>`;

  it('microdata InStock + buy control -> AVAILABLE with price', async () => {
    const { extractZepto } = await import('../src/adapters/zepto/signals');
    const r = extractZepto({ kind: 'html', html: inStockHtml, finalUrl: 'https://www.zepto.com/pn/x/pvid/y' });
    expect(r.overrideState).toBe(AvailabilityState.AVAILABLE);
    expect(r.price).toEqual({ minor: 2059900, currency: 'INR' });
  });

  it('microdata OutOfStock -> OUT_OF_STOCK', async () => {
    const { extractZepto } = await import('../src/adapters/zepto/signals');
    const r = extractZepto({ kind: 'html', html: oosHtml, finalUrl: 'https://www.zepto.com/pn/x/pvid/y' });
    expect(r.overrideState).toBe(AvailabilityState.OUT_OF_STOCK);
  });

  // Safety assertions run END-TO-END through observationFrom + the confidence
  // model — asserting on the raw ExtractResult can pass while the pipeline
  // still concludes AVAILABLE from positive-only signals.
  it('structured InStock WITHOUT a buy control -> UNKNOWN end-to-end, never AVAILABLE', async () => {
    const { extractZepto } = await import('../src/adapters/zepto/signals');
    const { observationFrom } = await import('../src/adapters/base');
    const html = inStockHtml.replace('<button>Add to Cart</button>', '');
    const obs = observationFrom({ kind: 'html', html, finalUrl: '' }, extractZepto, 1, 'browser');
    expect(obs.state).toBe(AvailabilityState.UNKNOWN);
  });

  it('structured InStock CONTRADICTED by out-of-stock text -> UNKNOWN end-to-end', async () => {
    const { extractZepto } = await import('../src/adapters/zepto/signals');
    const { observationFrom } = await import('../src/adapters/base');
    const html = inStockHtml.replace('</body>', '<div>Sold Out</div></body>');
    const obs = observationFrom({ kind: 'html', html, finalUrl: '' }, extractZepto, 1, 'browser');
    expect(obs.state).toBe(AvailabilityState.UNKNOWN);
  });

  it('HTTP-200 outage interstitial -> UNKNOWN end-to-end, never OUT_OF_STOCK', async () => {
    const { extractZepto } = await import('../src/adapters/zepto/signals');
    const { observationFrom } = await import('../src/adapters/base');
    const html = `<html><body><div>This service is currently unavailable, please try again later. Notify me.</div>${'<script>x</script>'.repeat(400)}</body></html>`;
    const obs = observationFrom({ kind: 'html', html, finalUrl: '' }, extractZepto, 1, 'browser');
    expect(obs.state).toBe(AvailabilityState.UNKNOWN);
  });

  it('no structured availability and no clear text -> UNKNOWN end-to-end', async () => {
    const { extractZepto } = await import('../src/adapters/zepto/signals');
    const { observationFrom } = await import('../src/adapters/base');
    const obs = observationFrom(
      { kind: 'html', html: '<html><body><div>Loading…</div></body></html>', finalUrl: '' },
      extractZepto, 1, 'browser',
    );
    expect(obs.state).toBe(AvailabilityState.UNKNOWN);
  });

  it('OOS text WITH product-page context (microdata price) -> OUT_OF_STOCK', async () => {
    const { extractZepto } = await import('../src/adapters/zepto/signals');
    const { observationFrom } = await import('../src/adapters/base');
    const html = `<html><body><span content="20599" itemprop="price"></span><div>Out of Stock</div><div>Notify Me</div></body></html>`;
    const obs = observationFrom({ kind: 'html', html, finalUrl: '' }, extractZepto, 1, 'browser');
    expect(obs.state).toBe(AvailabilityState.OUT_OF_STOCK);
  });
});

describe('search relevance filter (foreign-card rejection)', () => {
  it('zepto zero-result page with trending rail resolves NO candidates', async () => {
    const html = `
      <div>No results found for "G57 Power"</div>
      <a href="/pn/pepsi-can-330ml/pvid/11111111-2222-3333-4444-555555555555"><img alt="Pepsi Can 330ml"><span>₹40</span></a>
      <a href="/pn/tender-coconut/pvid/22222222-3333-4444-5555-666666666666"><img alt="Tender Coconut"><span>₹60</span></a>`;
    const adapter = new ZeptoAdapter(searchRuntime({ kind: 'html', html, finalUrl: 'https://www.zepto.com/search?query=G57%20Power' }));
    const out = await adapter.search({ text: 'G57 Power' }, CTX);
    expect(out).toHaveLength(0);
  });

  it('titleMatchesQuery requires a strict majority of query tokens', async () => {
    const { titleMatchesQuery } = await import('../src/adapters/html');
    expect(titleMatchesQuery('Motorola g57 Power Pantone Corsair', 'G57 Power')).toBe(true);
    expect(titleMatchesQuery('Motorola g67 Power Pantone Parachute', 'G57 Power')).toBe(false);
    expect(titleMatchesQuery('Apple iPhone 17e (256GB, Black)', 'iphone 17')).toBe(true);
    expect(titleMatchesQuery('Pepsi Can 330ml', 'G57 Power')).toBe(false);
    expect(titleMatchesQuery('vivo t5x 5g cyber green 128 gb', 'T5X')).toBe(true);
  });
});

describe('helpers', () => {
  it('platformSearchUrl encodes queries', () => {
    expect(platformSearchUrl('zepto', 'G57 Power')).toBe('https://www.zepto.com/search?query=G57%20Power');
    expect(platformSearchUrl('bigbasket', 'iphone 17')).toBe('https://www.bigbasket.com/ps/?q=iphone%2017');
  });

  it('decodeEntities handles the common entities', () => {
    expect(decodeEntities('a&amp;b&#39;c&quot;d&#x2F;e')).toBe(`a&b'c"d/e`);
  });
});
