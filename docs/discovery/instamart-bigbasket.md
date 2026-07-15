# Platform Discovery — Swiggy Instamart & BigBasket

**Method note:** Live pages and robots.txt for both sites returned HTTP 403
through the research proxy (WAF edge-blocks datacenter egress — itself a
finding: Stock Sentinel should run from the user's own residential machine,
which it does). Findings tagged *verified-by-fetch* come from **open-source
scraper source** read from GitHub raw/code-search (exact endpoints, cookies,
headers, JSON fields). *reported-by-sources* / *inference* as labelled.
Anti-bot evasion out of scope; WAF mentions are descriptive, to justify
strategy and politeness.

---

## SWIGGY INSTAMART (swiggy.com/instamart)

### Location management
- Web resolves a **dark-store `storeId` from GPS `lat`/`lng`** via
  `GET disc.swiggy.com/api/v1/instamart/home?lat=&lng=` →
  `data.storeMeta.primaryStoreId` (fallback `.../serviceability`).
  *(verified-by-fetch)*
- Location lives in cookies `lat`, `lng`, `address`, `userLocation` (JSON blob),
  `deviceId`, and critically an **`aws-waf-token`**. `storeId` also recoverable
  from page source (`/"storeId":"(\d+)"/`). *(verified-by-fetch)*
- **Catalog, price, and which items exist are per-`storeId`.** Every catalog/
  search call carries `storeId`/`primaryStoreId`/`secondaryStoreId`.
- **Multi-location wants a separate context/session per location** — the
  `aws-waf-token` + device/location cookies are bound to the context; hot-
  swapping location cookies mid-session causes cross-location contamination.
  *(inference from verified coupling)*
- Unserviceable area → no `primaryStoreId`/empty `storesInfo` → "not available
  in your area" (→ `UNAVAILABLE_IN_AREA`).

### Authentication
- **Guest browsing works** (catalog/search unauthenticated). **Location, not
  login, is the gate** — Instamart shows nothing until `lat/lng→storeId`
  resolves. Session persistence governed by `aws-waf-token` (the fragile,
  expiring element; re-minted by reloading in a real browser).
  *(verified-by-fetch)*

### Product search & URLs
- Search: `POST www.swiggy.com/api/instamart/search/v2?storeId=&primaryStoreId=`
  body `{query, page_type:"INSTAMART_SEARCH_PAGE", ...}`. Other: category
  `layout`, `category-listing/filter/v2`, `disc.swiggy.com/.../search`. Headers:
  `x-build-type: WEB` (or `x-build-version`), `x-device-id`, `matcher`,
  `latitude`/`longitude` on `disc.` calls. *(verified-by-fetch)*
- **Client-rendered SPA** — plain HTML GET is useless; need the JSON APIs or a
  JS browser. Items keyed by `itemId` inside store JSON; a durable public
  per-item web URL pattern was **not verifiable**.

### Inventory detection
- Authoritative: `variation.inventory.inStock` (bool). Product carries `id`,
  `name`, `brand`, `itemId`, `availability`. *(verified-by-fetch)*
- Price: `variation.price.offerPrice.units` (selling), `.mrp.units`,
  `.discountValue.units`.
- **False-positive trap:** under throttling the AWS WAF returns **HTTP 200 with
  an empty/placeholder body**. "No items ⇒ out of stock" would be a false
  reading. **The engine must treat empty/stub responses as `UNKNOWN`→retry,
  never `OUT_OF_STOCK`.** *(verified-by-fetch of write-up)*

### Rate limits & posture (descriptive)
- AWS WAF with `aws-waf-token`; datacenter/proxy IPs edge-blocked. Bulk work
  reportedly needs low concurrency; a personal monitor should be serialized,
  occasional. robots.txt broadly `Allow: /` with checkout/account disallows;
  catalog api not listed (exact directives unverifiable). Polite: **5–10 min/
  product**, serialized, jitter, hard backoff on 403/429/empty-stub.

### Monitoring strategy — **chosen: Playwright, one persistent context per location**
SPA gated on `lat/lng→storeId` and protected by a WAF token a real browser
mints/refreshes automatically. Raw-API polling is unreliable here because
(a) WAF 200-empty stubs mimic "no stock" and (b) `x-build-version`/`matcher`
drift with releases. Read the authoritative `inventory.inStock` from the
in-page network JSON (or observe Add vs Out-of-stock control). **One long-lived
browser context per pincode** (own cookie jar); resolve `storeId` once per
context and reuse. HTML-only not viable.

---

## BIGBASKET (bigbasket.com)

### Location management
- Pincode/GPS resolves a **service-area set `sa_ids`**, persisted in cookies
  `_bb_pin_code`, `_bb_lat_long` (b64 `lat|lng`), `_bb_addressinfo` (b64),
  `_bb_sa_ids`. Session/identity: `_bb_cid`, `_bb_vid`, `csrftoken`, and
  **`csurftoken`** (also header `x-csurftoken`). Storefront selected by
  `x-entry-context: bb-b2c` (id 100, standard) vs `bbnow` (id 10, 10-min
  quick-commerce). *(verified-by-fetch)*
- **Catalog, price, vouchers are city/service-area specific.** Different
  `sa_ids` → different catalog/stock. **One session/context per pincode**
  (the `sa_ids ↔ pincode ↔ csurftoken` triplet must stay consistent).
- Unserviceable pincode → empty `_bb_sa_ids`/`is_global=1` → "we don't deliver
  here yet" (→ `UNAVAILABLE_IN_AREA`).

### Authentication
- **Guest browsing works** — listing API and SSR product pages return stock/
  price without login, given location cookies. Login is phone-OTP, only for
  checkout. Akamai bot-manager cookies (`bm_ss`, `ak_bmsc`, `AKA_A2`, …) +
  `csurftoken` expire and are re-minted by a real browser. *(verified-by-fetch)*

### Product search & URLs
- Product: `bigbasket.com/pd/{product_id}/{slug}/` — **numeric `product_id` is
  a very stable key** (consistent across years); tracking query params
  droppable. Search: `bigbasket.com/ps/?q=&page=` (**robots-disallowed**).
- Internal listing JSON: `GET bigbasket.com/listing-svc/v2/products?type=ps&
  slug=&page=`. Headers: `x-channel: BB-WEB`, `x-entry-context`, `x-caller:
  UI-KIRK`, `x-csurftoken`, full cookie jar. *(verified-by-fetch)*
- **Next.js SSR** — the PDP HTML embeds `<script id="__NEXT_DATA__">` with full
  product JSON. Listing path `props.pageProps.SSRData.tabs[0].product_info.
  products[]`; PDP variant path `productDetails.children[]` (one per pack size).
  **A plain HTML GET of `/pd/` yields parseable stock/price without executing
  JS** — *if* seeded with valid location + Akamai cookies. *(verified-by-fetch)*

### Inventory detection
- **Authoritative, highly corroborated:** `product.availability.avail_status`
  — **`"001"` = in stock**, any other code = not available; production code
  also guards `availability.not_for_sale !== true`. Confirmed across ~8
  independent repos. *(verified-by-fetch, high confidence)*
- Price: MRP `pricing.discount.mrp`; selling `pricing.discount.prim_price.sp`.
  Name `desc`, brand `brand.name`, url `absolute_url`.

### Rate limits & posture (descriptive)
- **Akamai Bot Manager** + `csurftoken`; datacenter IPs edge-blocked. robots.txt
  disallows `/ps/`, `/p/`, `/product/`, `/_next/data/`; **`/pd/` not
  disallowed** → prefer monitoring known product IDs over search crawling.
  Analog personal projects advise: set pincode once, watch few products, run
  less often, reuse a session, prefer a real browser. Polite: **5–15 min/
  product**, serialized, jitter, hard backoff on 403/429.

### Monitoring strategy — **chosen: Playwright to seed/refresh a per-pincode session, then parse `__NEXT_DATA__` on `/pd/{id}`** (listing-svc JSON as optional fast path with same cookies)
SSR `__NEXT_DATA__` gives authoritative `avail_status`/`pricing` for a known
product without JS execution or search crawling, and `/pd/` isn't robots-
disallowed — the most reliable, false-positive-resistant signal. The blocker is
Akamai + `csurftoken`, which cold `requests` cannot mint, so a persistent
Playwright context sets the pincode and holds live cookies; the product page is
fetched within it and parsed for `productDetails.children[].availability.
avail_status == "001"`. **One context (cookie jar) per pincode.** Choose
`bbnow` for the 10-min catalog, `bb-b2c` for standard.

---

## Summary

| Dimension | Instamart | BigBasket |
|---|---|---|
| Rendering | client SPA (JSON XHR only) | Next.js SSR (`__NEXT_DATA__` in HTML) |
| Guest browse | yes | yes |
| Gate | location (lat/lng→storeId) | location (pincode→sa_ids) |
| Store concept | `storeId` dark store | `sa_ids`; `bb-b2c` vs `bbnow` |
| In-stock marker | `variation.inventory.inStock` | `availability.avail_status=="001"` (+`not_for_sale!=true`) |
| Price | `price.offerPrice.units`/`mrp.units` | `pricing.discount.prim_price.sp`/`mrp` |
| Anti-bot | AWS WAF; **200-empty stubs** | Akamai + `csurftoken` |
| False-positive risk | high (stubs look empty) → empty=UNKNOWN | low (explicit code) |
| Product URL | `itemId` (web URL unverified) | `/pd/{id}/{slug}/` (very stable) |
| Chosen strategy | Playwright, 1 context/location, read `inStock` from JSON | Playwright seed → parse `__NEXT_DATA__` on `/pd/{id}`, 1 context/pincode |

**Cross-cutting design rules adopted:**
1. **One persistent browser context (cookie jar) per monitored pincode** —
   never hot-swap location cookies within a session. This is the reliable
   answer to "check multiple pincodes" for all location-coupled platforms.
2. Reliability ranking: full-browser session > SSR/JSON parse seeded with
   browser cookies > cold HTTP. Only BigBasket has a truly parseable SSR page;
   Swiggy is SPA-only.
3. **Empty/stub/ambiguous response ⇒ `UNKNOWN`→retry, never `OUT_OF_STOCK`.**
   (Directly from Swiggy's WAF-stub behaviour.)
