# Stock Sentinel — Risk & Failure Analysis

**Document status:** Approved baseline (v1.0)

This document enumerates what can go wrong, how the system detects it, how it
recovers, and what the user sees. It is the specification behind the
reliability requirements (FR-M6, FR-R*, NFR-9) and the failure-recovery
workflow in the architecture doc §8.

---

## 1. Risk register (likelihood × impact → mitigation)

| # | Risk | Likelihood | Impact | Mitigation (design mechanism) |
|---|------|-----------|--------|------------------------------|
| R1 | **False "AVAILABLE" alert** (user rushes to buy, nothing there) | Med | **Critical** (destroys trust) | Two-signal agreement + two-poll confirmation + confidence gate (≥0.9) before alert; ambiguous ⇒ UNKNOWN; empty/stub ⇒ never available |
| R2 | Platform changes DOM/JSON shape → detector misreads | High (expected) | High | Signals are evidence, not booleans; shape mismatch ⇒ `UNKNOWN` + evidence snapshot + platform "degraded"; fixtures + adapter conformance tests catch regressions |
| R3 | Platform blocks/rate-limits the app (429/503/CAPTCHA) | Med | High | Per-platform token bucket + serialized queue + circuit breaker + exponential backoff (cap 1h); no retry storms; human cadence + jitter |
| R4 | Internet outage | High | Med | Global net probe → Offline mode (no fetches, no ERROR spam); auto-resume with schedule re-spread |
| R5 | Auth/session expiry | Med | Med | Detected via login-wall signature; degrade to guest; single user notification + one-click re-login; no credential handling |
| R6 | App crash / power loss mid-check | Med | Med | Crash-only design; SQLite WAL; intent+results persisted transactionally; restart = resume; dedup ledger prevents re-alert |
| R7 | Duplicate/repeated alerts | Med | Med (annoyance→muting) | Edge-triggered transitions + persisted dedup ledger + flap damping + cooldowns |
| R8 | Location contamination (pincode A's result attributed to B) | Med | High | One browser context (cookie jar) per pincode; location is part of target identity; ensureLocation verified before read |
| R9 | Memory growth over weeks | Med | Med | Context recycling ≤6h; observation retention/pruning; bounded log rotation; no unbounded in-memory history |
| R10 | Clock jumps (laptop sleep/wake) | High | Med | Monotonic scheduling via injected Clock; on wake, due targets re-spread with jitter, never stampede |
| R11 | Alert channel misconfig (bad SMTP/WhatsApp) | Med | Low | Per-channel test buttons; channel failures isolated + retried + surfaced; never block other channels |
| R12 | Playwright/Chromium crash or hang | Med | Med | Hard per-check timeout; context recycle + one retry next cycle; browser lifecycle owned by a supervisor |
| R13 | Disk full (history/logs) | Low | Med | Retention job + log rotation; low-disk guard pauses history writes with a warning, monitoring continues |
| R14 | User over-aggressive settings risking blocks | Med | Med | No "aggressive" preset; enforced per-platform minimum spacing floor the UI cannot go below |
| R15 | Legal/ToS exposure | Low | Med | Personal-use scope, human cadence, guest mode, no evasion, Responsible-Use disclosure in Help; user owns their usage |
| R16 | Time-zone / DST in retention & quiet hours | Low | Low | Store UTC; convert at display; quiet-hours evaluated in local tz via Clock |

---

## 2. Failure recovery matrix (cause → detection → response → user visibility)

| Cause | Detection | Automatic response | User visibility |
|---|---|---|---|
| **Internet outage** | Net probe fails (DNS/HTTPS to neutral host) before/after check | Engine → Offline; suspend fetches; hold schedule | One "Offline" banner + one history event; auto-clears |
| **Connectivity restored** | Net probe succeeds | Re-spread all due targets across first interval (jitter) | "Back online" banner; single event |
| **Platform outage (5xx site-wide)** | Repeated 5xx across targets of one platform | Circuit opens; half-open probe after cooldown | Platforms screen: "Amazon having trouble — retrying in Xm" |
| **Rate limit / soft block (429/CAPTCHA)** | HTTP status / block-page signature | Backoff level+1 (exp, cap 1h); reduce that platform's cadence | Platforms screen: "backoff" with countdown |
| **DOM/JSON shape change** | Signal extractor can't find expected markers coherently | Verdict `UNKNOWN` + raw evidence stored; platform "degraded" after N in a row | Platforms "degraded"; Logs has evidence; **no alert** |
| **Auth/session expiry** | Login-wall/redirect signature; probeSession confirms | Degrade platform to guest if possible, else suspend its targets | One notification + [Re-login]; targets show "needs sign-in" |
| **App restart / power loss** | Startup detects prior running state | Load targets + machine states; resume; honour paused | Dashboard shows resumed monitoring < 30s |
| **Browser context crash/hang** | Check timeout / context error | Recycle context; retry once next cycle | Silent unless repeated → target health "unstable" |
| **Partial failure (one target errors)** | Per-check try/catch + classification | Only that target backs off; siblings unaffected (bulkhead) | Target row shows ERROR badge + last good state retained |
| **Alert channel delivery failure** | Channel throws / non-2xx | Retry with backoff; other channels proceed | Alert card shows per-channel receipt (✓/⚠ retrying) |
| **Corrupt/locked DB** | SQLite open/integrity check fails | Fail over to JSON fallback store for the session + warn; attempt WAL recovery | Settings banner: "History storage issue — running in safe mode" |
| **Disk full** | Write ENOSPC / low-space probe | Pause history writes, keep monitoring, trigger retention prune | Warning banner with "free space" guidance |

---

## 3. False-positive defense in depth (the R1 deep-dive)

A false AVAILABLE alert is the one unacceptable failure. Five independent
layers must all pass before an AVAILABLE alert fires:

1. **Coherent evidence** — extractor returns signals that agree (e.g. buy
   button present *and* availability text positive *and*, where present,
   structured data `InStock`). Disagreement caps confidence → UNKNOWN.
2. **Confidence gate** — verdict confidence ≥ 0.9 for a direct alert; else a
   confirmation re-check is required.
3. **State-machine hysteresis** — entering AVAILABLE requires either
   high-confidence strong evidence or two consecutive AVAILABLE observations.
4. **Confirmation re-check** — an independent fresh fetch (new navigation),
   subject to the same politeness, must reproduce AVAILABLE.
5. **Dedup ledger + flap damping** — the edge must be new (not already
   alerted) and the target must not be in a volatile-stock cooldown.

Every alert stores the evidence snapshot that justified it, so any false
positive is auditable and becomes a fixture-backed test.

---

## 4. Long-running execution risks (weeks unattended)

| Concern | Control |
|---|---|
| Memory creep | Context recycle ≤6h; bounded caches; retention prune; heap watermark log |
| Handle/socket leaks | Single HTTP agent w/ keep-alive caps; browser contexts pooled + closed on recycle |
| Log growth | Rotating files (10×5MB); structured JSON; level filter |
| DB growth | Daily retention job; observations pruned+archived; VACUUM on schedule |
| Schedule drift after many sleep cycles | Monotonic clock; re-spread on wake; no absolute-timer accumulation |
| Token/cookie staleness | probeSession heartbeat per platform; refresh via browser before expiry where detectable |
| Silent death of one platform | Per-platform heartbeat; "no successful check in Xh" health alarm surfaced to user |

---

## 5. Security & privacy risks

- **Credentials:** never entered into or stored by the app; login happens in a
  real browser window the user drives; only the resulting session (in
  Chromium's own profile dir) persists.
- **Alert gateway secrets** (SMTP password, WhatsApp token): stored in the OS
  keychain where available, else an encrypted settings blob; never logged.
- **Data locality:** all data on the user's machine; outbound traffic only to
  monitored platforms + user-configured alert gateways; no telemetry.
- **Log hygiene:** secrets and cookies are redacted from logs and the
  diagnostics bundle.
