/**
 * Blinkit signal extraction. Grounded in discovery
 * (docs/discovery/blinkit-zepto.md):
 *   - Internal JSON API `/v6/search/products` returns product nodes.
 *   - In-stock truth: `inventory > 0` AND `is_sold_out === false` AND
 *     `in_stock !== false`.
 *   - Absent from results ⇒ not carried by this dark store ⇒ NOT_LISTED.
 *   - Price: `price` (selling), fallback `mrp`, in rupees.
 *
 * Pure. Operates on the parsed JSON returned by the runtime for a product ref
 * or search. Robust to the product node being nested.
 */

import { AvailabilityState, Money, Signal, SignalKind } from '../../core/types';
import { ExtractResult, collect } from '../base';
import { RawContent } from '../runtime';

function isProductNode(o: Record<string, unknown>): boolean {
  return 'inventory' in o || 'is_sold_out' in o || 'in_stock' in o || 'is_in_stock' in o;
}

function inStock(o: Record<string, unknown>): boolean {
  const inv = o['inventory'];
  const soldOut = o['is_sold_out'];
  const inStockFlag = o['in_stock'];
  const isInStock = o['is_in_stock'];
  const invOk = typeof inv === 'number' ? inv > 0 : inv === undefined ? true : true;
  const notSoldOut = soldOut !== true;
  const flagOk = inStockFlag !== false && isInStock !== false;
  // Require an affirmative inventory>0 when inventory is present; otherwise rely
  // on the boolean flags. Never treat "unknown" as in-stock.
  if (typeof inv === 'number') return inv > 0 && notSoldOut && flagOk;
  return notSoldOut && (inStockFlag === true || isInStock === true);
}

function priceOf(o: Record<string, unknown>): Money | undefined {
  const raw = o['price'] ?? o['normal_price'] ?? o['mrp'];
  const num = typeof raw === 'string' ? parseFloat(raw) : typeof raw === 'number' ? raw : NaN;
  if (Number.isFinite(num)) return { minor: Math.round(num * 100), currency: 'INR' };
  return undefined;
}

export function extractBlinkit(raw: RawContent): ExtractResult {
  if (raw.kind !== 'json' || raw.json === undefined) {
    return { signals: [{ kind: SignalKind.AMBIGUOUS_EMPTY, source: 'no json' }] };
  }
  const nodes = collect(raw.json, isProductNode);
  if (nodes.length === 0) {
    return { signals: [{ kind: SignalKind.NOT_FOUND_IN_CATALOG, source: 'no product nodes' }] };
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
    signals.push({ kind: SignalKind.API_IN_STOCK, source: 'inventory>0 && !is_sold_out' });
    if (price) signals.push({ kind: SignalKind.PRICE_PRESENT, source: 'price' });
    return { signals, price, overrideState: AvailabilityState.AVAILABLE, overrideConfidence: 0.95 };
  }
  price = priceOf(nodes[0]!);
  signals.push({ kind: SignalKind.API_OUT_OF_STOCK, source: 'is_sold_out / inventory<=0' });
  if (price) signals.push({ kind: SignalKind.PRICE_PRESENT, source: 'price' });
  return { signals, price, overrideState: AvailabilityState.OUT_OF_STOCK, overrideConfidence: 0.9 };
}
