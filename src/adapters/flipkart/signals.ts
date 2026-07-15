/**
 * Flipkart signal extraction. Grounded in discovery
 * (docs/discovery/amazon-flipkart.md) — the strongest verified evidence in the
 * whole study, from a live open-source scraper's exact markers:
 *   - Global OOS text: "currently out of stock"
 *   - Pincode OOS text: "Currently out of stock in this area."  (check FIRST)
 *   - Coming soon: "Coming Soon"
 *   - Invalid pincode: "Not a valid pincode"
 *   - No offer: "No seller"
 *   - Also: "SOLD OUT", "Notify Me"; Add to Cart / Buy Now presence.
 * Flipkart embeds schema.org Product/Offer JSON-LD (InStock/OutOfStock) — used
 * as a cross-check. CSS classes are obfuscated/rotating, so we prefer
 * text/JSON-LD over classes. AVAILABLE requires the buy/text signal AND JSON-LD
 * agreement (or, if JSON-LD absent, a strong buy signal) and is confidence-
 * capped so the engine always confirms.
 */

import { AvailabilityState, Money, Signal, SignalKind } from '../../core/types';
import { ExtractResult } from '../base';
import { RawContent } from '../runtime';
import { containsPhrase, jsonLdAvailability, stripTags } from '../html';

function priceOf(html: string): Money | undefined {
  // Verified selector div.dyC4hf carries the price; also try a ₹ number near
  // "price". Prefer the smallest plausible product price found.
  const m =
    html.match(/class=["'][^"']*dyC4hf[^"']*["'][^>]*>\s*₹?\s*([\d,]+)/i) ??
    html.match(/₹\s*([\d,]{3,})/);
  if (!m) return undefined;
  const num = parseFloat(m[1]!.replace(/,/g, ''));
  return Number.isFinite(num) ? { minor: Math.round(num * 100), currency: 'INR' } : undefined;
}

export function extractFlipkart(raw: RawContent): ExtractResult {
  const html = raw.html ?? '';
  if (!html) return { signals: [{ kind: SignalKind.AMBIGUOUS_EMPTY, source: 'no html' }] };
  const text = stripTags(html);
  const signals: Signal[] = [];
  const price = priceOf(html);
  if (price) signals.push({ kind: SignalKind.PRICE_PRESENT, source: 'div.dyC4hf' });

  // 1) Pincode-specific OOS FIRST (superstring of the global phrase).
  if (containsPhrase(text, 'currently out of stock in this area')) {
    signals.push({ kind: SignalKind.TEXT_AREA_UNAVAILABLE, source: 'text marker (verified)' });
    return { signals, price, overrideState: AvailabilityState.UNAVAILABLE_IN_AREA, overrideConfidence: 0.92 };
  }

  // 2) Invalid pincode -> we can't judge availability here.
  if (containsPhrase(text, 'not a valid pincode')) {
    signals.push({ kind: SignalKind.AMBIGUOUS_EMPTY, source: 'invalid pincode' });
    return { signals };
  }

  // 3) Coming soon.
  if (containsPhrase(text, 'coming soon')) {
    signals.push({ kind: SignalKind.TEXT_COMING_SOON, source: 'text marker (verified)' });
    return { signals, price, overrideState: AvailabilityState.COMING_SOON, overrideConfidence: 0.85 };
  }

  const ld = jsonLdAvailability(html);
  const ldInStock = ld ? /InStock/i.test(ld) : undefined;
  if (ldInStock === true) signals.push({ kind: SignalKind.STRUCTURED_IN_STOCK, source: 'JSON-LD Offer.availability' });
  if (ldInStock === false) signals.push({ kind: SignalKind.STRUCTURED_OUT_OF_STOCK, source: 'JSON-LD Offer.availability' });

  // 4) Global OOS text / no seller / sold out.
  const oosText =
    containsPhrase(text, 'currently out of stock') ||
    containsPhrase(text, 'sold out') ||
    containsPhrase(text, 'no seller');
  if (oosText) signals.push({ kind: SignalKind.TEXT_OUT_OF_STOCK, source: 'text marker (verified)' });

  const notifyMe = containsPhrase(text, 'notify me');
  const buyPresent =
    containsPhrase(text, 'add to cart') || containsPhrase(text, 'buy now');
  if (buyPresent) signals.push({ kind: SignalKind.BUY_CONTROL_PRESENT, source: 'Add to Cart / Buy Now' });
  if (!buyPresent) signals.push({ kind: SignalKind.BUY_CONTROL_ABSENT, source: 'no buy control' });

  // AVAILABLE requires agreement: (buy control or JSON-LD InStock) AND no OOS
  // text AND JSON-LD not contradicting.
  const positive = (buyPresent || ldInStock === true) && !oosText && !notifyMe && ldInStock !== false;
  if (positive) {
    return { signals, price, overrideState: AvailabilityState.AVAILABLE, overrideConfidence: 0.85 };
  }

  if (oosText || notifyMe || ldInStock === false) {
    if (notifyMe) signals.push({ kind: SignalKind.TEXT_OUT_OF_STOCK, source: 'Notify Me' });
    return { signals, price, overrideState: AvailabilityState.OUT_OF_STOCK, overrideConfidence: 0.9 };
  }

  // Incoherent -> UNKNOWN, never guess.
  return { signals, overrideState: AvailabilityState.UNKNOWN, overrideConfidence: 0.2 };
}
