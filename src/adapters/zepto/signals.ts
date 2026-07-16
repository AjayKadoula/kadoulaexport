/**
 * Zepto signal extraction. Grounded in discovery
 * (docs/discovery/blinkit-zepto.md):
 *   - Internal JSON API `/api/v3/search`; products nest under
 *     `data.sections[].items` (recursive collect required).
 *   - In-stock truth: `availabilityStatus === 'AVAILABLE'` AND
 *     `outOfStock === false` AND `availableQuantity > 0`.
 *   - Store non-serviceable (from `/store/select` `serviceable:false`) ⇒
 *     UNAVAILABLE_IN_AREA — the runtime marks this with `{ serviceable:false }`.
 *   - Absent from results ⇒ NOT_LISTED.
 *   - Price fields often in PAISE ⇒ divide by 100.
 */

import { AvailabilityState, Money, Signal, SignalKind } from '../../core/types';
import { ExtractResult, collect } from '../base';
import { stripTags } from '../html';
import { RawContent } from '../runtime';

function isVariantNode(o: Record<string, unknown>): boolean {
  return 'availabilityStatus' in o || 'outOfStock' in o || 'availableQuantity' in o;
}

function inStock(o: Record<string, unknown>): boolean {
  const status = o['availabilityStatus'];
  const oos = o['outOfStock'];
  const qty = o['availableQuantity'];
  const statusOk = status === undefined ? true : status === 'AVAILABLE';
  const notOos = oos !== true;
  const qtyOk = typeof qty === 'number' ? qty > 0 : true;
  // Require an affirmative signal: at least one of status==AVAILABLE or qty>0.
  const affirmative = status === 'AVAILABLE' || (typeof qty === 'number' && qty > 0);
  return statusOk && notOos && qtyOk && affirmative;
}

/** Zepto prices are frequently in paise; normalise to rupees minor units. */
function priceOf(o: Record<string, unknown>): Money | undefined {
  const raw =
    o['discountedSellingPrice'] ?? o['sellingPrice'] ?? o['superSaverSellingPrice'] ?? o['mrp'];
  let num = typeof raw === 'string' ? parseFloat(raw) : typeof raw === 'number' ? raw : NaN;
  if (!Number.isFinite(num)) return undefined;
  // Heuristic from discovery: values are usually paise. If the number is an
  // integer clearly too large to be rupees for a typical item, treat as paise.
  // We keep it in minor units (paise) directly: if it already looks like paise
  // (integer, large), minor = num; else minor = num*100.
  const looksPaise = Number.isInteger(num) && num >= 1000 && num % 1 === 0;
  const minor = looksPaise ? num : Math.round(num * 100);
  return { minor, currency: 'INR' };
}

export function extractZepto(raw: RawContent): ExtractResult {
  // Rendered product page (production runtime navigates the /pn/…/pvid/… URL):
  // truth is the schema.org Offer microdata the page embeds, corroborated by
  // the buy control. Verified live 2026-07: in-stock pages carry
  // `<link href="http://schema.org/InStock" itemprop="availability">` plus an
  // itemprop="price" content and an "Add to Cart" control.
  if (raw.kind === 'html' && raw.html) {
    return extractZeptoHtml(raw.html);
  }
  if (raw.kind !== 'json' || raw.json === undefined) {
    return { signals: [{ kind: SignalKind.AMBIGUOUS_EMPTY, source: 'no json' }] };
  }
  // Non-serviceable location marker.
  if ((raw.json as Record<string, unknown>)['serviceable'] === false) {
    return {
      signals: [{ kind: SignalKind.TEXT_AREA_UNAVAILABLE, source: 'store/select serviceable=false' }],
      overrideState: AvailabilityState.UNAVAILABLE_IN_AREA,
      overrideConfidence: 0.9,
    };
  }
  const nodes = collect(raw.json, isVariantNode);
  if (nodes.length === 0) {
    return { signals: [{ kind: SignalKind.NOT_FOUND_IN_CATALOG, source: 'no variant nodes' }] };
  }
  const signals: Signal[] = [];
  let price: Money | undefined;
  const anyInStock = nodes.some((n) => {
    if (inStock(n)) {
      price = price ?? priceOf(n);
      return true;
    }
    return false;
  });
  if (anyInStock) {
    signals.push({ kind: SignalKind.API_IN_STOCK, source: 'availabilityStatus=AVAILABLE' });
    if (price) signals.push({ kind: SignalKind.PRICE_PRESENT, source: 'sellingPrice' });
    return { signals, price, overrideState: AvailabilityState.AVAILABLE, overrideConfidence: 0.95 };
  }
  price = priceOf(nodes[0]!);
  signals.push({ kind: SignalKind.API_OUT_OF_STOCK, source: 'outOfStock / qty<=0' });
  if (price) signals.push({ kind: SignalKind.PRICE_PRESENT, source: 'sellingPrice' });
  return { signals, price, overrideState: AvailabilityState.OUT_OF_STOCK, overrideConfidence: 0.9 };
}

function extractZeptoHtml(html: string): ExtractResult {
  const signals: Signal[] = [];

  // schema.org Offer microdata: the only structured availability on the page.
  const availTag = /<[^>]*itemprop=["']availability["'][^>]*>/i.exec(html)?.[0];
  const structured = availTag ? /schema\.org\/(\w+)/i.exec(availTag)?.[1] : undefined;

  const text = stripTags(html);
  const hasAddToCart = /add to cart/i.test(text);
  const hasOosText = /out of stock|sold out|currently unavailable|notify me/i.test(text);

  // Microdata price: attribute order varies, scan the itemprop="price" tag.
  const priceTag = /<[^>]*itemprop=["']price["'][^>]*>/i.exec(html)?.[0];
  const priceNum = priceTag ? parseFloat(/content=["'](\d+(?:\.\d+)?)["']/.exec(priceTag)?.[1] ?? '') : NaN;
  const price: Money | undefined = Number.isFinite(priceNum)
    ? { minor: Math.round(priceNum * 100), currency: 'INR' }
    : undefined;
  if (price) signals.push({ kind: SignalKind.PRICE_PRESENT, source: 'itemprop=price' });

  if (structured && /^InStock$/i.test(structured)) {
    signals.push({ kind: SignalKind.STRUCTURED_IN_STOCK, source: 'microdata Offer.availability' });
    if (hasAddToCart) signals.push({ kind: SignalKind.BUY_CONTROL_PRESENT, source: 'Add to Cart' });
    // Coherent-evidence rule: structured InStock alone is not enough — require
    // the buy control to agree and no out-of-stock text contradiction.
    if (hasAddToCart && !hasOosText) {
      return { signals, price, overrideState: AvailabilityState.AVAILABLE, overrideConfidence: 0.9 };
    }
    // Incoherent page (InStock microdata but no buy control, or out-of-stock
    // wording alongside). Returning positive-only signals here would let the
    // confidence model conclude AVAILABLE — force UNKNOWN explicitly.
    if (!hasAddToCart) signals.push({ kind: SignalKind.BUY_CONTROL_ABSENT, source: 'no Add to Cart text' });
    if (hasOosText) signals.push({ kind: SignalKind.TEXT_OUT_OF_STOCK, source: 'page text contradicts microdata' });
    return { signals, price, overrideState: AvailabilityState.UNKNOWN, overrideConfidence: 0.3 };
  }
  if (structured && /^(OutOfStock|SoldOut|Discontinued)$/i.test(structured)) {
    signals.push({ kind: SignalKind.STRUCTURED_OUT_OF_STOCK, source: 'microdata Offer.availability' });
    return { signals, price, overrideState: AvailabilityState.OUT_OF_STOCK, overrideConfidence: 0.85 };
  }
  if (structured && /^PreOrder$/i.test(structured)) {
    signals.push({ kind: SignalKind.TEXT_PREORDER, source: 'microdata Offer.availability' });
    return { signals, price, overrideState: AvailabilityState.PREORDER, overrideConfidence: 0.85 };
  }
  // No structured availability: a text-only negative verdict is trusted ONLY
  // when the page demonstrably is a product page (microdata name/price
  // present) and the wording is a product OOS phrase — an HTTP-200 outage
  // interstitial or unhydrated shell must stay UNKNOWN, never OUT_OF_STOCK.
  const isProductPage = Boolean(priceTag) || /itemprop=["']name["']/i.test(html);
  const clearOosText = /out of stock|sold out|notify me/i.test(text);
  if (isProductPage && clearOosText && !hasAddToCart) {
    signals.push({ kind: SignalKind.TEXT_OUT_OF_STOCK, source: 'page text' });
    return { signals, price, overrideState: AvailabilityState.OUT_OF_STOCK, overrideConfidence: 0.75 };
  }
  signals.push({ kind: SignalKind.AMBIGUOUS_EMPTY, source: 'no structured availability on page' });
  return { signals, price, overrideState: AvailabilityState.UNKNOWN, overrideConfidence: 0.3 };
}
