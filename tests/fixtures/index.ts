/**
 * Synthetic fixtures modelling each platform's real response shapes (from the
 * discovery reports). Each is annotated with the availability state it should
 * produce. These drive the adapter signal-extraction tests: a real-world layout
 * change becomes a failing test rather than a silent production misread.
 */

import { AvailabilityState } from '../../src/core/types';
import { RawContent } from '../../src/adapters/runtime';

export interface Fixture {
  name: string;
  expected: AvailabilityState;
  raw: RawContent;
}

// --- BigBasket (Next.js SSR __NEXT_DATA__, avail_status "001") --------------
function bbHtml(products: unknown): RawContent {
  const nextData = { props: { pageProps: { productDetails: { children: products } } } };
  return {
    kind: 'html',
    html: `<html><body><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(nextData)}</script></body></html>`,
    finalUrl: 'https://www.bigbasket.com/pd/40126/x/',
  };
}
export const BIGBASKET_FIXTURES: Fixture[] = [
  {
    name: 'in stock',
    expected: AvailabilityState.AVAILABLE,
    raw: bbHtml([{ availability: { avail_status: '001', not_for_sale: false }, pricing: { discount: { prim_price: { sp: '134900' }, mrp: '139900' } } }]),
  },
  {
    name: 'out of stock',
    expected: AvailabilityState.OUT_OF_STOCK,
    raw: bbHtml([{ availability: { avail_status: '002', not_for_sale: false }, pricing: { discount: { prim_price: { sp: '134900' } } } }]),
  },
  {
    name: 'not for sale -> temporarily unavailable',
    expected: AvailabilityState.TEMPORARILY_UNAVAILABLE,
    raw: bbHtml([{ availability: { avail_status: '003', not_for_sale: true }, pricing: { discount: { prim_price: { sp: '134900' } } } }]),
  },
  {
    name: 'no products -> not listed',
    expected: AvailabilityState.NOT_LISTED,
    raw: bbHtml([]),
  },
  {
    name: 'malformed (no __NEXT_DATA__) -> unknown',
    expected: AvailabilityState.UNKNOWN,
    raw: { kind: 'html', html: '<html><body>totally different layout</body></html>', finalUrl: 'x' },
  },
  {
    name: 'blocked (403) -> unknown',
    expected: AvailabilityState.UNKNOWN,
    raw: { kind: 'html', html: '', finalUrl: 'x', blocked: true, httpStatus: 403 },
  },
];

// --- Blinkit (JSON, inventory/is_sold_out) ---------------------------------
function blinkitJson(node: unknown): RawContent {
  return { kind: 'json', json: { response: { products: [node] } }, finalUrl: 'https://blinkit.com/prn/x/prid/1' };
}
export const BLINKIT_FIXTURES: Fixture[] = [
  { name: 'in stock', expected: AvailabilityState.AVAILABLE, raw: blinkitJson({ name: 'X', prid: 1, inventory: 5, is_sold_out: false, in_stock: true, price: 199 }) },
  { name: 'sold out', expected: AvailabilityState.OUT_OF_STOCK, raw: blinkitJson({ name: 'X', prid: 1, inventory: 0, is_sold_out: true, price: 199 }) },
  { name: 'empty results -> not listed', expected: AvailabilityState.NOT_LISTED, raw: { kind: 'json', json: { response: { products: [] } }, finalUrl: 'x' } },
  { name: 'stub -> unknown', expected: AvailabilityState.UNKNOWN, raw: { kind: 'json', json: undefined, finalUrl: 'x', empty: true } },
];

// --- Zepto (JSON, availabilityStatus/outOfStock, paise) --------------------
function zeptoJson(items: unknown): RawContent {
  return { kind: 'json', json: { data: { sections: [{ items }] } }, finalUrl: 'https://www.zepto.com/pn/x/pvid/1' };
}
export const ZEPTO_FIXTURES: Fixture[] = [
  { name: 'in stock', expected: AvailabilityState.AVAILABLE, raw: zeptoJson([{ availabilityStatus: 'AVAILABLE', outOfStock: false, availableQuantity: 3, sellingPrice: 19900, mrp: 24900 }]) },
  { name: 'out of stock', expected: AvailabilityState.OUT_OF_STOCK, raw: zeptoJson([{ availabilityStatus: 'OUT_OF_STOCK', outOfStock: true, availableQuantity: 0, sellingPrice: 19900 }]) },
  { name: 'not serviceable -> area unavailable', expected: AvailabilityState.UNAVAILABLE_IN_AREA, raw: { kind: 'json', json: { serviceable: false }, finalUrl: 'x' } },
  { name: 'no items -> not listed', expected: AvailabilityState.NOT_LISTED, raw: zeptoJson([]) },
];

// --- Instamart (JSON, inventory.inStock, WAF stub) -------------------------
function instamartJson(variations: unknown): RawContent {
  return { kind: 'json', json: { data: { storeId: '1', widgets: [{ product: { variations } }] } }, finalUrl: 'https://swiggy.com/instamart' };
}
export const INSTAMART_FIXTURES: Fixture[] = [
  { name: 'in stock', expected: AvailabilityState.AVAILABLE, raw: instamartJson([{ inventory: { inStock: true }, price: { offerPrice: { units: 299 }, mrp: { units: 349 } } }]) },
  { name: 'out of stock', expected: AvailabilityState.OUT_OF_STOCK, raw: instamartJson([{ inventory: { inStock: false }, price: { offerPrice: { units: 299 } } }]) },
  { name: 'WAF empty stub -> unknown (NEVER out of stock)', expected: AvailabilityState.UNKNOWN, raw: { kind: 'json', json: {}, finalUrl: 'x' } },
  { name: 'real empty catalog -> not listed', expected: AvailabilityState.NOT_LISTED, raw: { kind: 'json', json: { data: { storeId: '1', widgets: [] } }, finalUrl: 'x' } },
  { name: 'runtime-flagged empty stub -> unknown', expected: AvailabilityState.UNKNOWN, raw: { kind: 'json', json: undefined, finalUrl: 'x', empty: true } },
];

// --- Amazon (HTML, #availability + buy button) -----------------------------
export const AMAZON_FIXTURES: Fixture[] = [
  {
    name: 'in stock',
    expected: AvailabilityState.AVAILABLE,
    raw: { kind: 'html', finalUrl: 'https://www.amazon.in/dp/XYZ', html: `<div id="availability"><span>In stock</span></div><input id="add-to-cart-button"><span class="a-offscreen">₹1,34,900</span>` },
  },
  {
    name: 'currently unavailable -> out of stock',
    expected: AvailabilityState.OUT_OF_STOCK,
    raw: { kind: 'html', finalUrl: 'x', html: `<div id="availability"><span>Currently unavailable.</span></div>` },
  },
  {
    name: 'temporarily out of stock',
    expected: AvailabilityState.TEMPORARILY_UNAVAILABLE,
    raw: { kind: 'html', finalUrl: 'x', html: `<div id="availability"><span>Temporarily out of stock.</span></div>` },
  },
  {
    name: 'delivery block -> area unavailable',
    expected: AvailabilityState.UNAVAILABLE_IN_AREA,
    raw: { kind: 'html', finalUrl: 'x', html: `<div id="glow-ingress">This item cannot be shipped to your selected delivery location.</div><input id="add-to-cart-button"><span class="a-offscreen">₹1,34,900</span>` },
  },
  {
    name: 'pre-order',
    expected: AvailabilityState.PREORDER,
    raw: { kind: 'html', finalUrl: 'x', html: `<div id="availability">Available to ship on 20 September.</div><input id="buy-now-button">` },
  },
  {
    name: 'buy button but no in-stock text -> unknown (no false positive)',
    expected: AvailabilityState.UNKNOWN,
    raw: { kind: 'html', finalUrl: 'x', html: `<div id="availability"><span>&nbsp;</span></div><input id="add-to-cart-button">` },
  },
];

// --- Flipkart (HTML text markers + JSON-LD) --------------------------------
function fkHtml(body: string, availability?: 'InStock' | 'OutOfStock'): RawContent {
  const ld = availability
    ? `<script type="application/ld+json">${JSON.stringify({ '@type': 'Product', offers: { '@type': 'Offer', availability: `https://schema.org/${availability}` } })}</script>`
    : '';
  return { kind: 'html', finalUrl: 'https://www.flipkart.com/x/p/itm?pid=ABC', html: `<html><body>${ld}${body}</body></html>` };
}
export const FLIPKART_FIXTURES: Fixture[] = [
  { name: 'in stock (buy + JSON-LD)', expected: AvailabilityState.AVAILABLE, raw: fkHtml(`<div class="dyC4hf">₹1,34,900</div><button>Add to Cart</button><button>Buy Now</button>`, 'InStock') },
  { name: 'global out of stock', expected: AvailabilityState.OUT_OF_STOCK, raw: fkHtml(`<div>Currently out of stock</div>`, 'OutOfStock') },
  { name: 'pincode out of stock -> area unavailable', expected: AvailabilityState.UNAVAILABLE_IN_AREA, raw: fkHtml(`<div>Currently out of stock in this area.</div>`) },
  { name: 'coming soon', expected: AvailabilityState.COMING_SOON, raw: fkHtml(`<div>Coming Soon</div>`) },
  { name: 'no seller -> out of stock', expected: AvailabilityState.OUT_OF_STOCK, raw: fkHtml(`<div>No seller</div>`) },
  { name: 'notify me -> out of stock', expected: AvailabilityState.OUT_OF_STOCK, raw: fkHtml(`<div class="dyC4hf">₹1,34,900</div><button>Notify Me</button>`) },
  { name: 'invalid pincode -> unknown', expected: AvailabilityState.UNKNOWN, raw: fkHtml(`<div>Not a valid pincode</div>`) },
];

export const ALL_FIXTURES = {
  amazon: AMAZON_FIXTURES,
  flipkart: FLIPKART_FIXTURES,
  blinkit: BLINKIT_FIXTURES,
  zepto: ZEPTO_FIXTURES,
  instamart: INSTAMART_FIXTURES,
  bigbasket: BIGBASKET_FIXTURES,
};
