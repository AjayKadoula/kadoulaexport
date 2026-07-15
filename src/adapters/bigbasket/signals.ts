/**
 * BigBasket signal extraction. Grounded in discovery
 * (docs/discovery/instamart-bigbasket.md):
 *   - BigBasket is Next.js SSR: the product page embeds a `__NEXT_DATA__`
 *     script with full product JSON.
 *   - Authoritative stock field: `availability.avail_status === "001"` (in
 *     stock), with a guard `availability.not_for_sale !== true`.
 *   - Price: `pricing.discount.prim_price.sp` (selling), `pricing.discount.mrp`.
 *   - Product variants live under `productDetails.children[]` (PDP) or
 *     `SSRData.tabs[0].product_info.products[]` (listing).
 *
 * This function is pure: it takes the parsed __NEXT_DATA__ object (or the raw
 * HTML from which we extract it) and returns signals + price. It is tested
 * against fixtures for every availability state.
 */

import { AvailabilityState, Money, Signal, SignalKind } from '../../core/types';
import { ExtractResult } from '../base';
import { RawContent } from '../runtime';

const AVAIL_IN_STOCK = '001';

export function parseNextData(html: string): unknown {
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return undefined;
  try {
    return JSON.parse(m[1]!);
  } catch {
    return undefined;
  }
}

/** Find the product node(s) inside a BigBasket __NEXT_DATA__ payload. */
export function findProducts(nextData: unknown): Record<string, unknown>[] {
  const pageProps = get(nextData, 'props', 'pageProps');
  // PDP shape
  const children = get(pageProps, 'productDetails', 'children');
  if (Array.isArray(children)) return children as Record<string, unknown>[];
  // Listing shape
  const tabs = get(pageProps, 'SSRData', 'tabs');
  if (Array.isArray(tabs)) {
    const products = get(tabs[0], 'product_info', 'products');
    if (Array.isArray(products)) return products as Record<string, unknown>[];
  }
  return [];
}

function get(obj: unknown, ...keys: string[]): unknown {
  let cur = obj;
  for (const k of keys) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}

function priceOf(product: Record<string, unknown>): Money | undefined {
  const sp = get(product, 'pricing', 'discount', 'prim_price', 'sp');
  const num = typeof sp === 'string' ? parseFloat(sp) : typeof sp === 'number' ? sp : NaN;
  if (Number.isFinite(num)) return { minor: Math.round(num * 100), currency: 'INR' };
  return undefined;
}

export function extractBigBasket(raw: RawContent): ExtractResult {
  const nextData = raw.kind === 'json' ? raw.json : parseNextData(raw.html ?? '');
  if (nextData === undefined) {
    // SSR present but unparseable shape -> ambiguous, force UNKNOWN.
    return { signals: [{ kind: SignalKind.AMBIGUOUS_EMPTY, source: '__NEXT_DATA__ missing' }] };
  }
  const products = findProducts(nextData);
  if (products.length === 0) {
    return { signals: [{ kind: SignalKind.NOT_FOUND_IN_CATALOG, source: 'no products in payload' }] };
  }

  // For a PDP with multiple pack sizes, treat AVAILABLE if any variant is in
  // stock (the user can buy that pack). Take price from the in-stock variant.
  const signals: Signal[] = [];
  let anyInStock = false;
  let notForSaleAll = true;
  let price: Money | undefined;

  for (const p of products) {
    const availability = get(p, 'availability') as Record<string, unknown> | undefined;
    const status = availability?.['avail_status'];
    const notForSale = availability?.['not_for_sale'] === true;
    if (!notForSale) notForSaleAll = false;
    if (status === AVAIL_IN_STOCK && !notForSale) {
      anyInStock = true;
      price = price ?? priceOf(p);
    }
  }

  if (anyInStock) {
    signals.push({ kind: SignalKind.API_IN_STOCK, source: 'availability.avail_status=001' });
    if (price) signals.push({ kind: SignalKind.PRICE_PRESENT, source: 'pricing.discount.prim_price.sp' });
    return { signals, price, overrideState: AvailabilityState.AVAILABLE, overrideConfidence: 0.96 };
  }

  if (notForSaleAll) {
    signals.push({ kind: SignalKind.TEXT_TEMPORARILY_UNAVAILABLE, source: 'not_for_sale=true' });
    return { signals, overrideState: AvailabilityState.TEMPORARILY_UNAVAILABLE, overrideConfidence: 0.85 };
  }

  signals.push({ kind: SignalKind.API_OUT_OF_STOCK, source: 'avail_status!=001' });
  price = price ?? priceOf(products[0]!);
  if (price) signals.push({ kind: SignalKind.PRICE_PRESENT, source: 'pricing' });
  return { signals, price, overrideState: AvailabilityState.OUT_OF_STOCK, overrideConfidence: 0.92 };
}
