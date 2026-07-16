# Stock Sentinel — User Guide

Welcome! Stock Sentinel watches products you want to buy and tells you the
moment they're actually purchasable at your location. This guide is for the
person using the app — no coding needed.

## 1. Installing

**Desktop app:** download the installer for your system (Windows `.exe`, macOS
`.dmg`, Linux `.AppImage`), run it, and launch Stock Sentinel. It lives in your
menu bar / system tray and keeps running even when the window is closed.

**Web mode (advanced / servers):** run `npm run serve` and open the URL it
prints (e.g. `http://127.0.0.1:4173`). It automatically picks a free port.
By default this uses a **simulated** runtime (safe demo data, no site
contact). For **real live monitoring** run it as `RUNTIME=real npm run serve`
(PowerShell: `$env:RUNTIME='real'; npm run serve`) — it then checks the actual
sites with the same browser engine the desktop app uses.

## 2. First run (about two minutes)

1. **Add a location.** Type the pincode you want deliveries to (e.g. `122001`)
   and give it a label like "Home". Add as many as you like.
2. **Enable platforms.** Tick the platforms to watch — Amazon, Flipkart,
   Blinkit, Zepto, Swiggy Instamart, BigBasket. All work in guest mode; you can
   sign in later for platforms where you prefer your own account.
3. **Add a product.** Type its name (e.g. "iPhone 17 Pro Max") — or paste a
   product link for the most precise matching — and click **Watch**.

That's it. The dashboard immediately starts checking and shows a live status
for every combination of product, platform, and location.

## 3. Understanding the status colours

Each row shows exactly one state. Colour + label are always shown together:

| State | Means |
|-------|-------|
| 🟢 **Available** | You can buy it now at this location |
| ⚪ **Out of stock** | Listed and delivers here, but no stock |
| 🟣 **Unavailable in area** | Listed, but not delivered to this pincode |
| 🔵 **Coming soon** | Announced, not orderable yet |
| 🟦 **Preorder** | Can be pre-ordered (not immediate stock) |
| 🟠 **Temporarily unavailable** | Platform has it off temporarily |
| ⚪ **Not listed** | Can't be found on this platform/store |
| 🟡 **Unknown** | The page was unclear — the app won't guess |
| 🔴 **Error** | A check failed (network/blocked); it retries automatically |

**Why "Unknown" matters:** if a page is ambiguous, Stock Sentinel says so rather
than risk telling you something is in stock when it isn't. This is deliberate.

## 4. Alerts

When a product becomes available (or a watched price drops), you get an alert.
Turn channels on in **Settings → Alerts**:

- **Desktop notification** — a system pop-up you can click to open the product.
- **Sound** — an audible chime (choose the sound).
- **Email** — enter your SMTP details and a recipient; use **Send test**.
- **WhatsApp** — paste a personal gateway URL (e.g. a CallMeBot link you set
  up); use **Send test**.

Every alert tells you the product, platform, pincode, price, time, state, a
direct link, and a **confidence** level. Click **Open product** to buy — Stock
Sentinel never buys for you.

**You won't be spammed.** Alerts fire only when something *changes* — a
restock, a reappearance, a meaningful price change. Staying in stock does not
re-alert. Rapid flapping collapses into a single "volatile stock" notice.

**Quiet hours:** silence desktop/sound overnight in Settings; alerts are still
recorded and email/WhatsApp can be set to come through anyway.

## 5. Everyday use

- **Pause / Resume:** the button in the header (and tray) pauses all monitoring
  — handy before you travel. Resume picks up where it left off.
- **Groups & profiles:** organise products into groups, and save reusable
  **profiles** ("iPhone Launch", "GPU Restock") bundling products + platforms +
  locations + alert settings. Activate a profile on launch morning.
- **History:** the History screen shows every state change, alert, and error,
  with search, filters, and CSV/JSON export.
- **Import/Export:** back up or share your products, locations, and profiles as
  files.

## 6. Signing in to a platform (optional)

Guest mode is enough for availability everywhere. If you want to use your own
account (e.g. saved addresses), go to **Platforms → Sign in**. A real browser
window opens on that platform's login page — you log in normally (Stock Sentinel
never sees your password). If a session later expires, you'll get a single
"needs sign-in" prompt with a one-click re-login.

## 7. Reliability you don't have to think about

- **Internet drops?** Monitoring pauses and auto-resumes; no error spam.
- **Laptop reboots / power cut?** Everything is saved; it resumes on restart and
  won't re-alert something it already told you about.
- **A platform changes its website?** The app shows that platform as "degraded"
  and marks affected checks "Unknown" instead of guessing — no false alerts.

## 8. Troubleshooting

| Symptom | What to do |
|---------|-----------|
| A platform shows "degraded" | Usually a site change; the app keeps other platforms running. Check for an app update. |
| Lots of "Unknown" for one platform | The app couldn't read that platform confidently. Try signing in, or wait — it may be a temporary block (it backs off automatically). |
| "Needs sign-in" | Click it and complete the login window. |
| BigBasket stuck on "Unknown" / keyword never resolves | BigBasket's edge protection often rejects automated sessions outright. Add the product in **URL mode** (paste its `bigbasket.com/pd/…` link) — the product link in the app then always points at the right page even when reads are blocked. |
| Quick-commerce shows Available but my pincode isn't served | In headless web mode, Zepto/Blinkit checks run without a per-pincode store session, so they reflect default/national availability (accurate for electronics shipped nationally; groceries vary by dark store). The desktop app's sign-in/location flow gives per-pincode truth. |
| No alerts arriving | Settings → Alerts → **Send test** for each channel; check quiet hours. |
| High memory after weeks | Normal browser contexts recycle every few hours; a restart fully resets. |

## 9. Responsible use

Stock Sentinel checks pages at a gentle, human pace, only for the products you
add, for your personal shopping. Please keep it that way — don't add hundreds of
products at very short intervals. Platform terms still apply to you; see
**Help → Responsible Use**.
