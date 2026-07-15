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
