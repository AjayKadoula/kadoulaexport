# Platform Discovery — Overview & Strategy Matrix

This directory contains the Phase 2 discovery study. It was produced **before**
any monitoring logic was implemented, per the project's "do not assume how any
platform works" requirement. Each report grounds its findings in evidence
(open-source code that calls these platforms, live URL structures, robots.txt
snippets) with per-finding confidence tags. Live retailer fetches were blocked
by the research environment's proxy; the desktop app runs on the user's own
residential machine, a materially more legitimate and reliable position.

Reports:
- [`amazon-flipkart.md`](amazon-flipkart.md)
- [`blinkit-zepto.md`](blinkit-zepto.md)
- [`instamart-bigbasket.md`](instamart-bigbasket.md)

## Chosen strategy per platform

| Platform | Runtime | Location model | Truth signal | Multi-pincode | Poll (default) |
|---|---|---|---|---|---|
| **Amazon.in** | Playwright, monitor `/dp/<ASIN>` | GLOW widget, session-bound | `#add-to-cart-button` present **AND** `#availability` not unavailable-keyword | re-set GLOW / context per pincode | 10–15 min |
| **Flipkart** | Playwright, monitor `/p/…?pid=` | on-page widget + Check | text markers ("Currently out of stock in this area." etc.) **+ JSON-LD `Offer.availability`** cross-check | widget re-entry per pincode | 5–10 min |
| **Blinkit** | Playwright-bootstrap → `/v6/search/products` JSON | lat/lon headers (stateless) | `inventory>0` & `is_sold_out=false` | swap lat/lon in same context | 10–15 min |
| **Zepto** | Playwright hybrid, per-store context | resolved `store_id` header | `availabilityStatus=='AVAILABLE'` & `outOfStock=false` & `availableQuantity>0` | per-store context map | 10–15 min |
| **Instamart** | Playwright, one context per location | lat/lng→`storeId` cookies | `variation.inventory.inStock`; **empty/WAF-stub ⇒ UNKNOWN** | one context per pincode | 5–10 min |
| **BigBasket** | Playwright seed → parse `__NEXT_DATA__` on `/pd/{id}` | pincode→`sa_ids` cookies | `availability.avail_status=="001"` & `not_for_sale!=true` | one context per pincode | 5–15 min |

## Universal design rules distilled from discovery

1. **Monitor stable canonical product URLs / product refs, never search pages.**
   Search is location-variant (false positives) and often robots-disallowed;
   product-page paths are allowed. Keyword mode is used only to *discover* the
   product ref once, then monitoring pins to that ref.
2. **One persistent browser context (cookie jar) per monitored pincode** for
   every location-coupled platform; never hot-swap location cookies within a
   session.
3. **Read structured/JSON truth signals over DOM buttons** where available
   (Blinkit/Zepto/Instamart JSON, BigBasket `__NEXT_DATA__`, Flipkart JSON-LD);
   DOM lags and CSS classes rotate.
4. **Empty / ambiguous / stub responses ⇒ `UNKNOWN` → retry, never
   `OUT_OF_STOCK` and never `AVAILABLE`.** (Swiggy WAF 200-empty stubs.)
5. **Distinguish "not deliverable to this pincode" (`UNAVAILABLE_IN_AREA`) from
   global out-of-stock (`OUT_OF_STOCK`).** Both platforms and quick-commerce
   surface these as different signals.
6. **Two-signal agreement + two-consecutive-poll confirmation before an
   AVAILABLE alert.** This is the primary false-positive control.
7. **Guest mode is sufficient for availability on all six**; login is optional
   and only ever completed by the user in a real browser window (checkout is
   out of scope).
8. **Politeness:** serialized per platform, 5–15 min cadence with jitter, hard
   exponential backoff on 403/429/503/CAPTCHA/empty-stub, honour `Retry-After`,
   single residential IP, no evasion.

These rules are enforced structurally by the engine (state machine hysteresis,
scheduler rate limits, confidence model) so an individual adapter cannot
accidentally violate them.
