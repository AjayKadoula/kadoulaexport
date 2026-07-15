/**
 * Swiggy Instamart signal extraction. Grounded in discovery
 * (docs/discovery/instamart-bigbasket.md):
 *   - Client-rendered SPA; the runtime returns the internal search/v2 JSON.
 *   - In-stock truth: per-variation `variation.inventory.inStock === true`.
 *   - Price: `variation.price.offerPrice.units` (selling), `mrp.units`.
 *   - CRITICAL: the AWS WAF returns HTTP 200 with an empty/placeholder body
 *     under throttling. The runtime flags this as `empty`, and base.guardSignals
 *     turns it into UNKNOWN. If we still get an empty products list here with no
 *     positive signal, we return NOT_LISTED only when the payload is clearly a
 *     real (non-stub) catalog response; otherwise UNKNOWN.
 */

import { AvailabilityState, Money, Signal, SignalKind } from '../../core/types';
import { ExtractResult, collect } from '../base';
import { RawContent } from '../runtime';

function isVariationNode(o: Record<string, unknown>): boolean {
  const inv = o['inventory'];
  return inv != null && typeof inv === 'object' && 'inStock' in (inv as Record<string, unknown>);
}

function inStock(o: Record<string, unknown>): boolean {
  const inv = o['inventory'] as Record<string, unknown> | undefined;
  return inv?.['inStock'] === true;
}

function priceOf(o: Record<string, unknown>): Money | undefined {
  const price = o['price'] as Record<string, unknown> | undefined;
  const offer = price?.['offerPrice'] as Record<string, unknown> | undefined;
  const units = offer?.['units'] ?? (price?.['mrp'] as Record<string, unknown> | undefined)?.['units'];
  const num = typeof units === 'number' ? units : parseFloat(String(units));
  if (Number.isFinite(num)) return { minor: Math.round(num * 100), currency: 'INR' };
  return undefined;
}

export function extractInstamart(raw: RawContent): ExtractResult {
  if (raw.kind !== 'json' || raw.json === undefined) {
    return { signals: [{ kind: SignalKind.AMBIGUOUS_EMPTY, source: 'no json' }] };
  }
  const nodes = collect(raw.json, isVariationNode);
  if (nodes.length === 0) {
    // Distinguish a genuine "not carried" catalog response from a WAF stub.
    // A real Instamart search response carries structural keys even when the
    // product list is empty. If those are absent, treat as UNKNOWN (stub).
    const looksReal = hasCatalogShape(raw.json);
    if (looksReal) {
      return { signals: [{ kind: SignalKind.NOT_FOUND_IN_CATALOG, source: 'empty catalog result' }] };
    }
    return { signals: [{ kind: SignalKind.AMBIGUOUS_EMPTY, source: 'stub-like payload (no catalog shape)' }] };
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
    signals.push({ kind: SignalKind.API_IN_STOCK, source: 'variation.inventory.inStock=true' });
    if (price) signals.push({ kind: SignalKind.PRICE_PRESENT, source: 'price.offerPrice.units' });
    return { signals, price, overrideState: AvailabilityState.AVAILABLE, overrideConfidence: 0.95 };
  }
  price = priceOf(nodes[0]!);
  signals.push({ kind: SignalKind.API_OUT_OF_STOCK, source: 'inventory.inStock=false' });
  if (price) signals.push({ kind: SignalKind.PRICE_PRESENT, source: 'price' });
  return { signals, price, overrideState: AvailabilityState.OUT_OF_STOCK, overrideConfidence: 0.9 };
}

function hasCatalogShape(json: unknown): boolean {
  // A real search response has recognisable envelope keys.
  const keys = ['data', 'cards', 'widgets', 'storeId', 'searchResults', 'gridElements'];
  const found = collect(json, (o) => keys.some((k) => k in o));
  return found.length > 0;
}
