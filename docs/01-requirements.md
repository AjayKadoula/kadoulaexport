# Stock Sentinel — Requirements Analysis

**Document status:** Approved baseline (v1.0)
**Audience:** Engineering, QA, Design

---

## 1. Product vision

Stock Sentinel is a desktop application that continuously monitors product
availability across multiple Indian e-commerce and quick-commerce platforms and
alerts the user the moment a watched product becomes purchasable at a watched
location. It is built for non-technical users, must run unattended for weeks,
and must never cry wolf: **a false "in stock" alert is the worst failure mode
the product has.**

### 1.1 Guiding principles (ranked)

1. **Reliability** — the app keeps monitoring through network outages, platform
   changes, machine restarts, and its own bugs.
2. **Trustworthiness** — alerts are verified before they are sent; duplicate
   alerts are suppressed; states are never over-simplified.
3. **Respectful operation** — the app behaves like a patient human shopper, not
   a scraper farm: low request rates, jittered schedules, no hammering,
   graceful back-off when a platform is unhappy. It monitors only what the
   user explicitly asked for, for personal purchasing use.
4. **Usability** — a non-technical user can install it, add "iPhone 17 Pro +
   Amazon/Flipkart + 122001" in under two minutes, and understand every state
   the app shows them.
5. **Extensibility** — adding platform #7 must not require touching the engine.

### 1.2 Explicit non-goals (v1)

- **Auto-purchase / checkout automation.** Out of scope; alerts only.
- **CAPTCHA solving or anti-bot evasion.** If a platform actively blocks the
  app, the app reports `ERROR/BLOCKED` state and backs off; it does not try to
  disguise itself beyond behaving like a normal browser session.
- **Cloud/multi-device sync.** v1 is a single local machine.
- **Price-history analytics.** Price is captured and shown, but charting and
  deal-scoring are future work.

---

## 2. Actors and use cases

### 2.1 Primary actor

*The Buyer* — a consumer trying to purchase a scarce product (phone launch,
GPU restock, sneaker drop, festival flash sale) or a hyperlocal grocery item
that keeps going out of stock. Not a developer. Runs Windows/macOS/Linux
laptop that sleeps and reboots.

### 2.2 Core use cases

| ID | Use case | Notes |
|----|----------|-------|
| UC-1 | Watch a product by keyword across N platforms and M pincodes | e.g. "iPhone 17 Pro Max" on 6 platforms × 3 pincodes = 18 monitor targets |
| UC-2 | Watch a specific product URL | Highest precision; preferred when the user has the link |
| UC-3 | Receive an alert the moment a target flips to AVAILABLE | Desktop + sound + email + WhatsApp, per user preference |
| UC-4 | Pause everything before a flight; resume later | Engine lifecycle control |
| UC-5 | Prepare a "launch profile" days ahead (products + platforms + locations + alert settings), activate on launch morning | Profiles |
| UC-6 | Review what happened overnight | History with filters/export |
| UC-7 | Log in to a platform once so monitoring uses their session | Voluntary; guest mode is the default wherever it works |
| UC-8 | Recover automatically after laptop reboot / Wi-Fi drop | No user action required |

---

## 3. Functional requirements

### 3.1 Product management (FR-P)

- FR-P1 Add product: display name, monitoring mode (keyword or URL-per-platform),
  match rules (must-include / must-exclude terms, price ceiling), tags/group.
- FR-P2 Edit, FR-P3 Delete (with confirmation; history retained), FR-P4
  Duplicate, FR-P5 Enable/Disable without deleting.
- FR-P6 Group products (named groups, used for filtering and profiles).
- FR-P7 Import/Export products as JSON (and CSV import for keyword lists).
- FR-P8 No hard cap on product count; UI and engine degrade gracefully
  (scheduling fairness) as counts grow.

### 3.2 Platform management (FR-PL)

- FR-PL1 Enable/disable each platform globally; select-all / deselect-all.
- FR-PL2 Per-platform settings: polling interval override, session (guest vs
  logged-in), max concurrency (always 1 for browser-based platforms).
- FR-PL3 Platform health visible at all times (OK / degraded / blocked /
  needs-login / unserviceable).

### 3.3 Location management (FR-L)

- FR-L1 Add/remove pincodes; label them ("Home", "Office").
- FR-L2 Bulk add (paste list), import/export.
- FR-L3 Validate pincodes (format: 6 digits, first digit 1–9) at entry;
  serviceability per platform is discovered at first check and surfaced.
- FR-L4 No hard cap; the engine schedules fairly across locations.

### 3.4 Monitoring engine (FR-M)

- FR-M1 Monitor target = (product × platform × location). Targets are
  materialised from products/platforms/locations/profiles.
- FR-M2 Keyword monitoring: platform search → candidate matching → product
  resolution → availability read.
- FR-M3 URL monitoring: direct product page/API availability read.
- FR-M4 Lifecycle: Start / Pause / Resume / Stop / Restart, globally and
  per-target.
- FR-M5 Long-running: continuous operation ≥ 30 days without restart;
  bounded memory; log rotation; browser context recycling.
- FR-M6 Failure in one platform/target never affects others (bulkhead
  isolation).
- FR-M7 Human-like cadence: per-platform rate limits, jittered intervals,
  session reuse, no location switching more often than necessary, exponential
  back-off on errors and on soft-block signals.

### 3.5 Availability model (FR-A)

The system distinguishes **nine** terminal states per check:

| State | Meaning |
|-------|---------|
| `AVAILABLE` | Purchasable now at this location |
| `OUT_OF_STOCK` | Listed, deliverable area, no stock |
| `UNAVAILABLE_IN_AREA` | Listed, but not deliverable/serviceable to this pincode |
| `COMING_SOON` | Announced, not yet orderable |
| `PREORDER` | Orderable as pre-order (not immediate stock) |
| `TEMPORARILY_UNAVAILABLE` | Platform marks it as temporarily off (e.g. "Currently unavailable") |
| `NOT_LISTED` | Product cannot be found on this platform/store catalog |
| `UNKNOWN` | Page fetched but signals ambiguous — never guess |
| `ERROR` | Check failed (network, block, parse failure) |

These states must never be collapsed. `UNKNOWN` and `ERROR` are first-class:
an ambiguous page is `UNKNOWN`, never `AVAILABLE`.

### 3.6 Alerting (FR-AL)

- FR-AL1 Channels: desktop notification, sound, email (SMTP), WhatsApp (via
  user-configured gateway, e.g. CallMeBot or Twilio credentials the user
  supplies). Multiple channels simultaneously.
- FR-AL2 Every alert carries: product, platform, location, price, timestamp,
  availability state, direct product link, confidence level.
- FR-AL3 **Verification before alert:** an AVAILABLE transition is confirmed by
  a re-check (independent fetch) before any alert fires, unless the signal was
  already high-confidence (structured data + buy-box) — see Alert Validation
  design in architecture doc §7.
- FR-AL4 Deduplication: alerts fire only on state transitions, significant
  price changes (configurable threshold), or reappearance after
  NOT_LISTED/expiry of a cooldown. Never on repeated identical observations.
- FR-AL5 Channel failure isolation: email failing must not block desktop
  notification; failed channel deliveries are retried with back-off and
  recorded.

### 3.7 History & reporting (FR-H)

- FR-H1 Persist: every state transition, every alert (with delivery outcomes),
  monitoring lifecycle events, errors, user actions (audit log).
- FR-H2 Search + filter (by product, platform, location, state, date range).
- FR-H3 Export CSV/JSON.
- FR-H4 Retention rules: raw check records pruned after N days (default 30);
  transitions and alerts kept 1 year; user-configurable; archive-to-file on
  prune.

### 3.8 Sessions & login (FR-S)

- FR-S1 Guest mode is default wherever the platform allows browsing.
- FR-S2 User can voluntarily log in through an embedded real browser window;
  the app never sees or stores the password — only the resulting session
  (cookies/storage in a per-platform persistent browser profile).
- FR-S3 Sessions persist across app restarts.
- FR-S4 Session expiry is detected (login-wall/redirect signatures), monitoring
  for that platform degrades to guest where possible, and the user is notified
  with a one-click re-login flow.

### 3.9 Profiles (FR-PR)

- FR-PR1 A profile bundles: product set, platform set, location set, alert
  settings, monitoring settings (intervals/aggressiveness).
- FR-PR2 Create / edit / clone / delete / import / export (JSON).
- FR-PR3 Activating a profile materialises its targets; multiple profiles can
  be active; conflicts resolve by union with the most-frequent interval winning.

### 3.10 Persistence & recovery (FR-R)

- FR-R1 All configuration, state, history, and sessions persist locally
  (SQLite + browser profile dirs) and restore automatically on start.
- FR-R2 Crash/power-cut safe: SQLite WAL mode; single-writer; no state kept
  only in memory longer than one check cycle.
- FR-R3 On startup the engine resumes exactly the targets that were running,
  honouring pause states.
- FR-R4 Recovery matrix (internet outage, platform outage, auth expiry, etc.)
  — see Failure Analysis doc.

---

## 4. Non-functional requirements

| ID | Requirement |
|----|-------------|
| NFR-1 | Detection latency: a target checked at its configured interval (default 3–10 min per platform class); alert dispatch < 15 s after confirmed transition |
| NFR-2 | False-positive rate: target < 1 per 1,000 alerts; every AVAILABLE alert traceable to recorded evidence (raw signals snapshot) |
| NFR-3 | Memory: < 1.5 GB steady state with 50 targets incl. headless browser contexts; browser contexts recycled every ≤ 6 h |
| NFR-4 | CPU: near-idle between checks; checks serialised per platform |
| NFR-5 | Disk: history DB bounded by retention; logs rotated (10 × 5 MB) |
| NFR-6 | Startup to monitoring-resumed < 30 s |
| NFR-7 | All platform I/O behind adapter interface; new platform = new adapter module + manifest, zero engine change |
| NFR-8 | App usable fully offline for configuration; monitoring pauses and auto-resumes with connectivity |
| NFR-9 | Politeness: per-platform minimum spacing between requests (default ≥ 60 s per platform per location), global concurrency cap, mandatory jitter ±20%, immediate back-off (exponential, capped 1 h) on HTTP 429/503/block signatures |
| NFR-10 | Privacy: everything stays on the user's machine; outbound traffic only to monitored platforms + user-configured alert gateways |

---

## 5. Constraints & assumptions

- Platforms offer **no public availability APIs**; all detection is derived
  from what a normal browser session sees. Signals are therefore *fragile* —
  the architecture assumes selectors/endpoints will break and treats
  "signal shape changed" as a first-class state (`UNKNOWN`) with telemetry.
- Quick-commerce catalogs are **hyperlocal**: availability is a function of the
  dark store serving the location, so location context is part of a check's
  identity, not an afterthought.
- Some platforms may require login for full catalog access; the app supports
  it but never automates credential entry.
- Legal/ToS: the app performs low-volume personal-use reads of pages the user
  could view manually, identifies itself as a normal browser session, and honours
  back-off signals. Users are informed (Help → Responsible Use) that platform
  terms apply to them.

---

## 6. Acceptance criteria (v1 release gate)

1. All nine availability states reachable and visible in UI with fixtures.
2. Kill -9 during active monitoring → restart → monitoring resumes, no data
   loss, no duplicate alert for a transition already alerted.
3. Wi-Fi disabled 30 min → re-enabled → all targets recover without user
   action; exactly one "connectivity restored" event logged.
4. Simulated platform HTML change (fixture with unrecognised layout) →
   `UNKNOWN` state, no alert, degradation surfaced in Platforms screen.
5. AVAILABLE flap (available on one check, gone on confirm) → **no alert**,
   flap recorded in history.
6. 24 h soak test with mock adapters at 100 targets: zero unhandled
   rejections, memory plateau, scheduler fairness within 10%.
