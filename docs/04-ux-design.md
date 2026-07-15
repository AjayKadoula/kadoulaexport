# Stock Sentinel — UX Design

**Document status:** Approved baseline (v1.0)

---

## 1. UX principles

1. **Glanceable truth.** The user's core question is "is anything available,
   and is the app actually working?" The Dashboard answers both in one glance:
   a live target grid + an engine health strip. Nothing hides behind menus.
2. **States, not spinners.** Every target always shows one of the nine
   availability states with a colour + icon + plain-language tooltip
   ("Unavailable in your area — Blinkit doesn't deliver this to 122018").
   `UNKNOWN`/`ERROR` are shown honestly, never disguised as "checking…".
3. **Two-minute setup.** Add-Product is a single dialog: name/keyword or URL →
   pick platforms (chips) → pick locations (chips) → done. Defaults handle the
   rest. Power features (match rules, price ceiling, intervals) live behind
   "Advanced".
4. **Trust through evidence.** Every alert and every state chip links to the
   observation that produced it: timestamp, screenshot-free evidence list
   ("Buy button present · Price ₹134,900 · Structured data: InStock"), and the
   product link. Users forgive missed states; they don't forgive lies.
5. **Non-technical vocabulary.** "Paused", "Watching", "Needs sign-in",
   "Platform having trouble" — never "circuit breaker open", "429", "selector
   miss". Logs screen keeps the technical detail for power users.

## 2. Information architecture & navigation

Left icon rail (persistent): **Dashboard · Products · Platforms · Locations ·
Alerts · History · Profiles · Settings · Logs · Help · About**, with a global
engine control cluster (Start/Pause/Stop + status dot) pinned at the bottom of
the rail and mirrored in the OS tray menu. Closing the window minimises to
tray; monitoring continues (explained on first close).

## 3. Wireframes (key screens)

### 3.1 Dashboard

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ ▶ Watching 14 targets · All platforms OK · Last check 12s ago     [Pause All]│
├──────────────────────────────────────────────────────────────────────────────┤
│ ┌ Availability now ────────────────┐  ┌ Engine health ───────────────────┐   │
│ │ ● 1 AVAILABLE  ● 9 OUT OF STOCK  │  │ Amazon    ✓ ok       3m interval │   │
│ │ ● 2 NOT LISTED ● 1 AREA UNAVAIL  │  │ Flipkart  ✓ ok       3m          │   │
│ │ ● 1 ERROR                        │  │ Blinkit   ⚠ backoff  next 8m     │   │
│ └──────────────────────────────────┘  │ Zepto     🔑 needs sign-in  [Fix]│   │
│                                       └──────────────────────────────────┘   │
│ Targets                                       filter: [product ▾][state ▾]   │
│ ┌────────────────────────┬─────────┬────────┬────────────┬───────┬────────┐  │
│ │ Product                │Platform │ Pincode│ State      │ Price │ Checked│  │
│ ├────────────────────────┼─────────┼────────┼────────────┼───────┼────────┤  │
│ │ iPhone 17 Pro Max      │ Amazon  │ 122001 │ ● AVAILABLE│134,900│ 12s ago│  │
│ │ iPhone 17 Pro Max      │ Flipkart│ 122001 │ ● OOS      │   —   │ 1m ago │  │
│ │ PS5 Pro                │ Blinkit │ 122018 │ ● AREA     │   —   │ 4m ago │  │
│ └────────────────────────┴─────────┴────────┴────────────┴───────┴────────┘  │
│ Recent alerts:  🔔 09:12 iPhone 17 Pro Max AVAILABLE on Amazon (122001) [Open]│
└──────────────────────────────────────────────────────────────────────────────┘
```

### 3.2 Add Product (dialog)

```
┌ Add product ───────────────────────────────────────────────┐
│ What do you want to watch?                                 │
│ (•) Search by name   ( ) I have product links              │
│ Name/keywords: [ iPhone 17 Pro Max 256GB          ]        │
│ Platforms:  [Amazon ✓][Flipkart ✓][Blinkit ][Zepto ]       │
│             [Instamart ][BigBasket ]      [Select all]     │
│ Locations:  [122001 ✓ Home][122002 ✓][122018 ]  [+ Add]    │
│ ▸ Advanced (match words, exclude words, max price,         │
│            check frequency, group)                         │
│                       [Cancel]        [Start watching]     │
└────────────────────────────────────────────────────────────┘
```
URL mode swaps the keyword field for one URL field per selected platform
(platform auto-detected from pasted URL).

### 3.3 Alerts screen
Chronological cards: state-colour bar, product · platform · pincode · price ·
confidence badge ("Confirmed twice"), delivery receipts per channel
(✓ desktop, ✓ sound, ✉ sent, ⚠ WhatsApp failed – retrying), [Open product]
[Mute this target 1h] [Evidence].

### 3.4 Platforms screen
One row per platform: enable toggle, session card (Guest / Signed in as ·
last verified · [Sign in]/[Sign out]), health (ok/degraded/backoff/blocked with
plain-language explanation + next retry countdown), politeness settings
(interval preset: Relaxed/Normal — no "aggressive" preset), per-platform test
button ("Run one check now").

### 3.5 Other screens (definitions)

| Screen | Contents | Key interactions |
|---|---|---|
| Products | Table + groups sidebar; enable toggle per row; bulk select | Add/Edit/Duplicate/Delete/Import/Export; row → target detail |
| Locations | Pincode chips with labels + per-platform serviceability matrix (✓/✗/?) | Add, bulk paste, validate, import/export |
| History | Unified filterable timeline (transitions, alerts, errors, lifecycle); date range; full-text search | Export CSV/JSON; evidence drill-down; archive settings link |
| Profiles | Card per profile (products/platforms/locations/alerts summary); Active badge | Create/Edit/Clone/Export/Import/Delete/Activate/Deactivate |
| Settings | Alert channels (with [Send test]), quiet hours, retention, startup (launch at login, resume monitoring), sound picker, email SMTP form, WhatsApp gateway setup wizard | Validation with test buttons per channel |
| Logs | Technical log viewer (level filter, follow mode, open log folder) | Copy diagnostics bundle |
| Help | Responsible-use note, FAQ, state glossary (9 states in plain words), troubleshooting | — |
| About | Version, licenses, data location on disk | Check updates |

## 4. Primary user flows

### 4.1 First run
Welcome → choose locations (pincode + label) → enable platforms (all on by
default except sign-in-required ones, which show "works after sign-in") →
optional sign-ins → add first product (dialog above) → Dashboard with the
first checks visibly completing. Total ≤ 5 screens.

### 4.2 Alert received → purchase
OS notification (product, platform, price, pincode) → click → app foregrounds
on Alert card → [Open product] launches default browser at the product URL
(the user buys manually; we never auto-purchase). Sound continues until the
alert is acknowledged (configurable).

### 4.3 Session expired
Tray + dashboard badge "Zepto needs sign-in" (single notification, not
repeated) → Platforms → [Sign in] opens a real browser window on Zepto's login
page → user completes OTP → window auto-closes on success → targets resume.
While signed out, Zepto targets show `Paused — needs sign-in`, not ERROR spam.

### 4.4 Launch-day profile
Profiles → New → pick products/platforms/locations/alert channels → save as
"iPhone Launch" (inactive) → on launch morning: [Activate]. Deactivating
returns targets to their pre-profile state.

## 5. Interaction specifications

- **State colours:** AVAILABLE green; PREORDER teal; COMING_SOON blue;
  OUT_OF_STOCK grey; TEMPORARILY_UNAVAILABLE amber; UNAVAILABLE_IN_AREA
  purple; NOT_LISTED dashed-grey; UNKNOWN yellow; ERROR red. Icons + text
  always accompany colour (colour-blind safe).
- **Optimistic UI never lies:** toggles apply instantly in UI but show a small
  sync dot until the engine confirms; failures roll back with a toast.
- **Destructive actions** (delete product/profile, clear history) require
  typed-name or confirm dialog; deletes never remove history rows (soft
  reference retained).
- **Empty states** teach: e.g., empty Dashboard shows a 3-step "Add your first
  product" walkthrough.
- **Keyboard:** global ⌘/Ctrl-N add product; table navigation with arrows;
  `/` focuses filter.
- **Accessibility:** all interactive elements labelled; live-region
  announcements for state changes; minimum 4.5:1 contrast; UI scale setting.
- **Quiet hours:** alerts still recorded, sound/desktop suppressed, badge
  shows count on return (email/WhatsApp configurable to ignore quiet hours).
