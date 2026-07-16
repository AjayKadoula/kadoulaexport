# Platform Discovery — Blinkit & Zepto

**Method note:** Live retailer domains were not fetchable from the research
environment (outbound proxy blocks them). Findings tagged *verified-by-fetch*
were confirmed against **open-source code** that calls these platforms — most
importantly a personal PS5 stock-tracker (`shobhit8797/ps5-tracker`), the
closest real analog to Stock Sentinel — plus `pricely`, `flit`, `TrueCheck`,
`Kompare`, and live product URLs surfaced by search. *reported-by-sources* =
search summaries of write-ups; *inference* = reasoned from verified facts.
Anti-bot evasion was explicitly **not** researched; politeness guidance is.

> **These are undocumented, private endpoints outside each platform's ToS.**
> The architecture treats them as brittle: versioned paths, rotating
> `app_version`/signature headers, and edge protection all mean "shape can
> change without notice" is a first-class, expected event (→ `UNKNOWN`, not a
> crash).

---

## BLINKIT (blinkit.com)

### Location management
- Location is captured by **locality search (autocomplete) or GPS**, geocoded
  to **lat/lon** — pincode is only an input that resolves to coordinates.
  *(verified-by-fetch)*
- Location travels as **request headers `lat` and `lon`** on every catalog/
  search call, and is persisted in cookies `gr_1_lat`, `gr_1_lon`,
  `gr_1_locality`, `gr_1_landmark`, `gr_1_deviceId`. *(verified-by-fetch)*
- The serving **dark store is resolved server-side from lat/lon**; the client
  does not have to send a store id for search (contrast Zepto).
- **Multi-location is easy**: location is effectively stateless per request, so
  N pincodes are checked by swapping `lat`/`lon` headers within one browser
  context — no separate login per location. *(inference from verified design)*
- Unserviceable pincode → empty/non-serviceable catalog, "coming soon" screen.

### Authentication
- **Guest browsing works** — search/availability reachable with no OTP login;
  trackers hit `/v6/search/products` with only lat/lon + `app_client`.
  *(verified-by-fetch)* Optional `auth_key`/Bearer exist; **OTP is required
  only at checkout**, which we never do. Low session fragility for read-only
  monitoring.

### Product search & URLs
- Product URL: `blinkit.com/prn/<slug>/prid/<numeric_id>`; the **`prid` is
  stable and location-independent** (slug cosmetic). *(verified — live URLs)*
- Web app is a **JS SPA** — plain HTML GET returns a shell, not stock state.
- Internal JSON APIs observed: `GET/POST /v6/search/products?q=&search_type=6`
  (main), `/v2/search`, `/v1/layout/search`, legacy
  `api2.grofers.com/v1/layout/feed`. Headers: `lat`, `lon`,
  `app_client: consumer_web`, `web_app_version`, `device_id`, optional
  `auth_key`/`Authorization`, `x-xsrf-token`. *(verified-by-fetch)*

### Inventory detection
- API truth fields: `inventory` (integer; **≤0 ⇒ out of stock**),
  `is_sold_out` (bool), `in_stock`/`is_in_stock`. **Absent from results ⇒ not
  carried by that store** (→ `NOT_LISTED`). *(verified-by-fetch)*
- Price: `price` (selling), fallback `mrp`, generally in rupees on the web
  search API.
- UI: in-stock → "ADD"; OOS → "Out of Stock"/notify; not-carried → not shown;
  out-of-area → non-serviceable screen.

### Rate limits & posture (descriptive)
- Behind **Cloudflare with TLS/JA3 fingerprinting**; naive clients see **429**
  under load. robots.txt could not be verified → assume bot-disallowed, lean on
  cadence. The PS5 tracker recommends **every 6h / twice daily** and "keep the
  built-in delays." Stock Sentinel default: **≥ one check per product per
  10–15 min with jitter**, single IP, never parallel.

### Monitoring strategy — **chosen: Playwright-bootstrap → JSON-API poll (hybrid)**
HTML fetch rejected (SPA). Pure HTTP-API is fragile against Cloudflare/JA3.
Chosen: launch a real browser once per location to establish cookies +
lat/lon, then poll `/v6/search/products` **reusing that browser context** (so
requests carry a genuine TLS/cookie profile), and read the
`inventory`/`is_sold_out` **JSON** fields as the truth signal — never scrape
button DOM (it lags). Three pincodes = three lat/lon header variants through
the same context.

---

## ZEPTO (zeptonow.com → zepto.com)

### Location management
- Locality search / GPS → **lat/lon**. Zepto additionally **resolves a
  `store_id` (UUID)** via a serviceability call and requires it echoed on every
  search:
  `GET api.zeptonow.com/api/v2/store/select/?latitude=X&longitude=Y` →
  `store_id`/`storeId`, **`serviceable` boolean**, `society_id`.
  *(verified-by-fetch)* Persisted in cookies and re-sent as `store_id`/
  `storeId`/`x-store-id` headers.
- Catalog is scoped to the resolved store. **Multi-location is moderate**:
  maintain a `{pincode → store_id}` map and swap store headers per poll.
- Unserviceable pincode → `serviceable: false` (→ `UNAVAILABLE_IN_AREA`).

### Authentication
- **Guest browsing works** (`app_sub_platform: WEB` + `appVersion`, no token).
  Newer flows optionally add `Authorization: Bearer`, `x-access-token`, and a
  **`request-signature` (SHA256)** + app-version pinning — optional for
  browsing but an anti-tamper/fragility signal. OTP only at checkout.
  *(verified-by-fetch)*

### Product search & URLs
- Product URL: `zepto.com/pn/<slug>/pvid/<UUID>`; **`pvid` stable, location-
  independent**. Domain migrated `zeptonow.com → zepto.com` (both resolve).
- **Next.js SPA** — need the JSON API or a headless browser.
- Internal APIs: `POST api.zeptonow.com/api/v3/search`
  (`{query, page_number, mode}`), newer
  `bff-gateway.zeptonow.com/user-search-service/api/v3/search`; store resolve
  `/api/v2/store/select/`. Headers: `store_id`, `platform: WEB`, `appVersion`,
  `tenant: ZEPTO`, `deviceid`, optional `Authorization`, `request-signature`.
  **Products nest under `data.sections[].items` (recursive collect).**
  *(verified-by-fetch)*

### Inventory detection
- API truth fields: `availabilityStatus === 'AVAILABLE'`, `outOfStock` (bool),
  `availableQuantity` (**0 ⇒ OOS**). Absent ⇒ `NOT_LISTED`;
  `serviceable:false` ⇒ `UNAVAILABLE_IN_AREA`. *(verified-by-fetch)*
- Price: `sellingPrice`/`discountedSellingPrice`/`superSaverSellingPrice` +
  `mrp`, **often in paise (÷100)**.

### Rate limits & posture (descriptive)
- Edge-protected; `request-signature` + app-version pinning raise brittleness.
  Same conservative cadence as Blinkit. robots.txt unverified → assume
  bot-disallowed.

### Monitoring strategy — **chosen: Playwright hybrid, per-store context**
Use a real browser to set each location once and capture `store_id` + cookies
(+ let the frontend compute `request-signature`, avoiding reimplementation of
Zepto's signing scheme — a major fragility source), then poll `/api/v3/search`
reusing that context and read `outOfStock`/`availableQuantity`/
`availabilityStatus`. Three pincodes = three resolved store contexts.

> **2026-07 live validation update.** The product page (`/pn/<slug>/pvid/<id>`)
> now renders headlessly with no location set and makes **no interceptable
> availability API call on load** — the data ships inside the page (RSC flight
> payload). The page embeds **schema.org Offer microdata**
> (`<link href="http://schema.org/InStock" itemprop="availability">` +
> `itemprop="price"`), corroborated by the Add to Cart control. The
> implemented check therefore navigates the product URL and reads the
> microdata + buy control conjunction (see `zepto/signals.ts`,
> `extractZeptoHtml`); ambiguity still ⇒ UNKNOWN. The `/api/v3/search` poll
> remains the documented fallback for store-scoped checks. Keyword search is
> served by the rendered `/search?query=` page's product-card anchors.

---

## Summary

| Dimension | Blinkit | Zepto |
|---|---|---|
| Location on API | headers `lat`,`lon` (+cookies) | resolved `store_id` header |
| Multi-pincode | easy (stateless headers) | moderate (per-store map) |
| Guest browsing | yes | yes |
| Product URL | `/prn/<slug>/prid/<num>` | `/pn/<slug>/pvid/<uuid>` |
| SPA | yes | yes |
| In-stock signal | `inventory>0`, `is_sold_out=false` | `availabilityStatus=='AVAILABLE'`, `outOfStock=false`, `availableQuantity>0` |
| Price | `price`/`mrp` (rupees) | `sellingPrice`/`mrp` (paise ÷100) |
| Chosen strategy | Playwright-bootstrap → API poll | Playwright hybrid, per-store context |

**Cross-cutting:** both are guest-accessible SPAs with JSON truth signals
(never trust DOM buttons); Blinkit location is stateless lat/lon, Zepto needs a
per-location store_id; reliability-first strategy for both is a Playwright-
bootstrapped hybrid. Default cadence 10–15 min/product with jitter, single IP.
