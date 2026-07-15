# Platform Discovery — Amazon.in & Flipkart

**Method note:** The research environment's proxy blocks direct HTTPS to
retail/anti-bot-vendor hosts, so live product DOM was not fetched first-hand.
GitHub raw was reachable: Flipkart markers below tagged *verified-by-fetch*
come from verbatim source of `dvishal485/flipkart-product-stock`. Amazon
findings are *reported-by-sources* (search-surfaced vendor blogs, robots.txt
snippets, community projects) or *inference*. Anti-bot evasion was not
researched.

> Both platforms' **product-page paths are allowed by robots.txt** (`/dp/<ASIN>`
> on Amazon, `/p/` on Flipkart), while **search paths are disallowed**
> (`/search?` on Flipkart; several `/s?...` and `/dp/product-availability/`
> variants on Amazon). This is a strong reason to monitor **canonical product
> URLs, not search pages**. Automated monitoring is still against each
> platform's ToS — Stock Sentinel scopes activity to the user's own watched
> products, at human cadence, for personal purchasing use.

---

## AMAZON.IN

### Location management
- Pincode is set via the header **GLOW ("Deliver to") widget**; it drives
  per-pincode delivery eligibility and shipping speed.
- Under the hood the widget POSTs to
  `/gp/delivery/ajax/address-change.html` (`zipCode`, `locationType=
  LOCATION_INPUT`, `storeContext`, `actionSource=glow`) and needs an
  `anti-csrftoken-a2z` first fetched from `/gp/glow/get-address-selections.html`.
  *(reported-by-sources)*
- Location is bound **server-side to the session** (cookies `session-id`,
  `ubid-acbin`, `i18n-prefs`, `lc-acbin`; login adds `at-acbin`), not a clean
  pincode cookie. Checking N pincodes = re-running the address-change handshake
  sequentially in one session, or separate cookie jars per pincode for
  concurrency. *(inference)*
- Pincode affects availability: a product can be **"cannot be shipped to your
  selected delivery location"** (distinct from global OOS). *(reported-by-sources)*

### Authentication
- **Login not required** to view product page, price, or availability; guest
  browsing shows stock and permits pincode entry. Purchase needs an account,
  but monitoring does not. Login only adds saved addresses / faster checkout.
  `session-id`/`ubid` are long-lived; login tokens rotate. *(reported-by-sources)*

### Product search & URLs
- Product: `amazon.in/dp/<ASIN>` (canonical) — the **10-char ASIN is the stable
  key**, directly monitorable long-term. Search: `amazon.in/s?k=<query>`,
  location-variant ordering.
- AJAX/JSON endpoints exist (address-change, offer-listing) but are
  **CSRF-gated, undocumented, fragile, ToS-sensitive** — not a detector base.

### Inventory detection
- Signals are **HTML, not JSON-LD** (Amazon retail pages generally do **not**
  expose `schema.org Offer.availability`):
  - `#availability` text: "In stock", "Currently unavailable.",
    "Only N left in stock", "Temporarily out of stock".
  - Buy controls: `#add-to-cart-button` / `#buy-now-button` present ⇒ buyable;
    absent + "Currently unavailable" ⇒ global OOS.
  - Buy box/seller: `#merchant-info`, `#sellerProfileTriggerId`.
  - Pincode-undeliverable keeps offer/price but shows a delivery-block message.
  - Pre-order → buy button with "Pre-order"/"Available to ship on <date>".
  - Price: `.a-price .a-offscreen`, `#corePrice_feature_div`.
  *(reported-by-sources)*

### Rate limits & posture (descriptive)
- **Very aggressive** anti-bot; naive HTTP gets 503/CAPTCHA fast. robots.txt
  allows `/dp/<ASIN>` but disallows `/dp/product-availability/`. Polite cadence:
  **≥ 10–15 min/product with jitter**, honour `Retry-After`, exponential
  backoff on 503/429/CAPTCHA, never burst.

### Monitoring strategy — **chosen: Playwright, GLOW-pinned, monitor `/dp/<ASIN>`**
Search-page and JSON-ajax approaches rejected (reorder/false-positive risk;
CSRF-gated/fragile). Chosen: full browser survives anti-bot far better than raw
HTTP, renders `#availability`/buy-button correctly, and sets delivery location
once so "not deliverable here" is separable from global OOS. Detect stock as a
**conjunction**: `#add-to-cart-button` present **AND** `#availability` not in
the unavailable-keyword set; **confirm across two consecutive polls** before
alerting. (Plain-HTTP `/dp/` fetch is retained only as a degraded fallback.)

---

## FLIPKART.COM

### Location management
- Pincode entered in the on-page **"Deliver to" widget + "Check"** button; the
  site's own JS runs the serviceability lookup (pincode is **not** a param/
  cookie/header — it's applied to rendered page state for the session, carried
  by cookies incl. `SN`). *(verified-by-fetch for widget-driven behavior)*
- Pincode strongly affects price, stock, delivery, COD; a product can be
  **"Currently out of stock in this area."** while in stock elsewhere.
  *(verified-by-fetch — distinct code branch)*
- Multiple pincodes = re-enter each in the widget within one browser session
  (state overwrites); no separate login needed.

### Authentication
- **Login not required** to view product/price/stock; the verified scraper
  reads everything as guest. Login only adds saved addresses/checkout. Guest
  cookies persist across requests. *(verified-by-fetch)*

### Product search & URLs
- Product: `flipkart.com/<slug>/p/itm<code>?pid=<PID>&lid=<LID>&marketplace=
  FLIPKART` — the **`pid` is the stable key**; `lid` pins a specific seller
  listing. Search: `flipkart.com/search?q=<query>` (**robots-disallowed**).
- Internal React page-data JSON APIs exist but are undocumented/header-gated/
  fragile/ToS-sensitive; the official Affiliate/Seller APIs don't give
  arbitrary per-pincode stock. Not a reliable base.

### Inventory detection (strongest verified evidence)
From `dvishal485/flipkart-product-stock` — exact text/XPath markers:
- Global OOS: `//div[contains(text(),"currently out of stock")]`.
- Coming soon/pre-order: `//div[contains(text(),"Coming Soon")]`.
- **Pincode-specific OOS: `//div[contains(text(),"Currently out of stock in
  this area.")]`** — separates not-deliverable-to-pin from global OOS.
- Invalid pin: `"Not a valid pincode"`. No offer: `"No seller"`.
- Price: `div.dyC4hf`; discount `//span[contains(text(),"% off")]`; title `h1`.
*(all verified-by-fetch)*
- Also reported: "SOLD OUT", "Notify Me", Add-to-Cart/Buy-Now presence.
  **CSS classes are obfuscated and rotate** (`_30jeq3`, `dyC4hf`) → prefer
  text/XPath. Flipkart **does** embed `schema.org Product/Offer` JSON-LD
  (`InStock`/`OutOfStock`) — a stable secondary cross-check (may not reflect
  per-pincode nuance).

### Rate limits & posture (descriptive)
- **Moderate-to-aggressive**; raw scrapers IP-blocked on frequent hits.
  robots.txt disallows `/search?`, allows `/p/`. Polite cadence: **~5–10 min/
  product with jitter**, browser-like headers, exponential backoff on
  429/503/block.

### Monitoring strategy — **chosen: Playwright, pincode-widget set, monitor `/p/…?pid=`**
Search-page (robots-disallowed, location-variant) and internal JSON (fragile)
rejected. Chosen: browser renders JS-loaded price/stock; the **verified text
markers** cleanly separate pincode-OOS from global OOS; require agreement
between the **buy-button/text signal and JSON-LD `Offer.availability`**, and
**confirm across two consecutive polls** before alerting. (Plain-HTTP fetch +
JSON-LD parse retained as degraded fallback.)

---

## Summary

| Dimension | Amazon.in | Flipkart |
|---|---|---|
| Pincode | GLOW widget (CSRF ajax), session-bound | on-page widget + Check, session state |
| Login to view stock | no | no |
| Stable URL key | `/dp/<ASIN>` | `/p/…?pid=<PID>` |
| Search robots | partly disallowed | `/search?` disallowed |
| Global-OOS marker | `#availability` "Currently unavailable" + no buy button | text "currently out of stock" |
| Not-here marker | GLOW delivery-block, price retained | "Currently out of stock in this area." |
| JSON-LD availability | usually absent (parse HTML) | present (cross-check) |
| Anti-bot | very high | moderate–high |
| Chosen strategy | Playwright, GLOW-pinned `/dp/<ASIN>`, buy+text conjunction, 2-poll confirm | Playwright, widget-set `/p/…?pid=`, text+JSON-LD, 2-poll confirm |

**Cross-cutting:** monitor stable canonical product URLs (ASIN/PID), fix
delivery location once, treat "not deliverable to this pincode" as its own
state, require two-signal agreement + two-consecutive-poll confirmation before
alerting (this drives false positives toward zero), poll at ~10-min cadence
with jitter and backoff, honour `Retry-After`, personal-use scope only.
