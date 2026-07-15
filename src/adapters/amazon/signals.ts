/**
 * Amazon.in signal extraction. Grounded in discovery
 * (docs/discovery/amazon-flipkart.md):
 *   - Availability lives in HTML, not JSON-LD (Amazon retail pages usually omit
 *     schema.org Offer.availability).
 *   - Buy controls: #add-to-cart-button / #buy-now-button presence.
 *   - #availability text: "In stock", "Currently unavailable.",
 *     "Only N left in stock", "Temporarily out of stock".
 *   - Pincode-undeliverable keeps price/offer but shows a delivery-block message.
 *   - Pre-order: buy button labelled "Pre-order" / "Available to ship on <date>".
 *   - Price: .a-price .a-offscreen / #corePrice_feature_div.
 *
 * Detection uses a CONJUNCTION for AVAILABLE (buy control present AND
 * availability text not in the unavailable set), which is the false-positive
 * control the discovery report recommends. Confidence is capped below the
 * direct-alert threshold so the engine always confirms Amazon restocks.
 */

import { AvailabilityState, Money, Signal, SignalKind } from '../../core/types';
import { ExtractResult } from '../base';
import { RawContent } from '../runtime';
import { containsPhrase, elementText, hasElementId, stripTags } from '../html';

const AREA_MARKERS = [
  'cannot be shipped to your selected',
  'does not deliver to',
  "doesn't deliver to",
  'not available at this location',
];
const OOS_MARKERS = ['currently unavailable', 'we don’t know when', "we don't know when"];
const TEMP_MARKERS = ['temporarily out of stock'];
const PREORDER_MARKERS = ['pre-order', 'available to ship on', 'available for pre-order'];
const IN_STOCK_MARKERS = ['in stock', 'only ', 'left in stock'];

function priceOf(html: string): Money | undefined {
  // .a-offscreen carries the full price string like "₹1,34,900"
  const m =
    html.match(/class=["']a-offscreen["']>\s*₹?\s*([\d,]+(?:\.\d+)?)/i) ??
    html.match(/id=["']priceblock_(?:ourprice|dealprice)["'][^>]*>\s*₹?\s*([\d,]+(?:\.\d+)?)/i);
  if (!m) return undefined;
  const num = parseFloat(m[1]!.replace(/,/g, ''));
  return Number.isFinite(num) ? { minor: Math.round(num * 100), currency: 'INR' } : undefined;
}

export function extractAmazon(raw: RawContent): ExtractResult {
  const html = raw.html ?? '';
  if (!html) return { signals: [{ kind: SignalKind.AMBIGUOUS_EMPTY, source: 'no html' }] };

  const fullText = stripTags(html).toLowerCase();
  const availText = (elementText(html, 'availability') ?? '').toLowerCase();
  const signals: Signal[] = [];
  const price = priceOf(html);
  if (price) signals.push({ kind: SignalKind.PRICE_PRESENT, source: '.a-offscreen' });

  // 1) Delivery-block to this pincode (offer retained) -> UNAVAILABLE_IN_AREA
  if (AREA_MARKERS.some((m) => containsPhrase(fullText, m))) {
    signals.push({ kind: SignalKind.TEXT_AREA_UNAVAILABLE, source: 'delivery block message' });
    return { signals, price, overrideState: AvailabilityState.UNAVAILABLE_IN_AREA, overrideConfidence: 0.9 };
  }

  // 2) Pre-order
  if (PREORDER_MARKERS.some((m) => containsPhrase(fullText, m))) {
    signals.push({ kind: SignalKind.TEXT_PREORDER, source: 'pre-order label' });
    return { signals, price, overrideState: AvailabilityState.PREORDER, overrideConfidence: 0.85 };
  }

  // 3) Temporarily out of stock
  if (TEMP_MARKERS.some((m) => containsPhrase(availText || fullText, m))) {
    signals.push({ kind: SignalKind.TEXT_TEMPORARILY_UNAVAILABLE, source: '#availability' });
    return { signals, price, overrideState: AvailabilityState.TEMPORARILY_UNAVAILABLE, overrideConfidence: 0.85 };
  }

  // 4) Buy controls + availability text conjunction -> AVAILABLE
  const buyPresent = hasElementId(html, 'add-to-cart-button') || hasElementId(html, 'buy-now-button');
  const inStockText = IN_STOCK_MARKERS.some((m) => containsPhrase(availText, m));
  const unavailableText = OOS_MARKERS.some((m) => containsPhrase(availText || fullText, m));

  if (buyPresent) signals.push({ kind: SignalKind.BUY_CONTROL_PRESENT, source: '#add-to-cart-button' });
  else signals.push({ kind: SignalKind.BUY_CONTROL_ABSENT, source: 'no buy button' });
  if (inStockText) signals.push({ kind: SignalKind.TEXT_AVAILABLE, source: '#availability' });

  if (buyPresent && inStockText && !unavailableText) {
    // Capped at 0.85 so the engine always runs a confirmation re-check (Amazon
    // anti-bot / transient rendering means we never single-shot an alert).
    return { signals, price, overrideState: AvailabilityState.AVAILABLE, overrideConfidence: 0.85 };
  }

  // 5) Global out of stock
  if (unavailableText || (!buyPresent && !inStockText && availText)) {
    signals.push({ kind: SignalKind.TEXT_OUT_OF_STOCK, source: '#availability "currently unavailable"' });
    return { signals, price, overrideState: AvailabilityState.OUT_OF_STOCK, overrideConfidence: 0.9 };
  }

  // 6) Couldn't read a coherent state. We deliberately do NOT let a lone buy
  //    button imply AVAILABLE — the conjunction failed, so force UNKNOWN rather
  //    than risk a false positive.
  return { signals, overrideState: AvailabilityState.UNKNOWN, overrideConfidence: 0.2 };
}
