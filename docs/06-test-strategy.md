# Stock Sentinel — Test Strategy

**Document status:** Approved baseline (v1.0)

## 1. Philosophy

The engine is a **pure, port-based state machine**: it takes observations and
time, and emits transitions and alerts. That makes the highest-value behaviour
(false-positive prevention, dedup, recovery, scheduling fairness)
**deterministically testable** with a fake clock and scripted adapters — no
network, no flakiness. Platform adapters are tested against **captured
fixtures**, so a real-world layout change becomes a failing unit test rather
than a silent production misread.

Test pyramid: many fast unit tests (core + signal extraction) → fewer
integration tests (engine + storage + alert pipeline wired together with fakes)
→ a small set of scenario/soak simulations (recovery, long-run) → thin manual/
smoke checks of the Electron UI.

## 2. Layers & coverage targets

| Layer | Scope | Tooling | Target |
|---|---|---|---|
| Unit — core | state machine, scheduler, rate limiter, circuit breaker, confidence, dedup | Vitest + fake clock | ≥95% of `src/core` |
| Unit — signals | each adapter's `extractSignals`/`verdict` vs fixtures | Vitest + fixture HTML/JSON | every state per platform |
| Integration | engine ⇄ storage ⇄ alerts with scripted adapters + fake channels | Vitest | all recovery scenarios |
| Contract | every adapter satisfies the `PlatformAdapter` conformance suite | Vitest shared suite | all 6 adapters |
| Scenario | crash/restart, offline/online, block/backoff, flap, session-expiry | Vitest + fake clock | acceptance criteria §6 of requirements |
| Soak (simulated) | 30-day compressed run, 100 targets, mock adapters | Vitest long test (fake clock) | memory plateau, fairness, zero unhandled rejections |
| Smoke (manual) | Electron app launches, screens render, add-product flow | checklist | pre-release |

## 3. Key test cases (mapped to requirements)

### 3.1 State machine & false-positive control (R1, FR-A, FR-AL3)
- OUT_OF_STOCK → AVAILABLE with strong evidence conf 0.95 → **alert**.
- OUT_OF_STOCK → AVAILABLE conf 0.6 → **no alert until confirmation** re-check;
  confirm reproduces → alert; contradict → **no alert**, flap recorded.
- AVAILABLE flap (available then gone on confirm) → **no alert** (R1 case in
  acceptance criteria).
- Ambiguous/empty/stub observation → `UNKNOWN`, last real state preserved, no
  alert (Swiggy WAF-stub case).
- ERROR streak → target degraded, **one** user notification, last real state
  preserved (no spurious "reappeared").
- Price change ≥ threshold in AVAILABLE → price alert; below threshold → none.
- Flapping > K/hour → single "volatile stock" alert + cooldown.

### 3.2 Dedup ledger (FR-AL4, R6, R7)
- Same edge observed twice → one alert.
- Restart after alert committed → **no duplicate** for that edge.
- Reappearance after cooldown expiry → new alert.

### 3.3 Scheduler & rate limiter (NFR-9, R3, R10)
- Never more than one in-flight request per platform.
- Token bucket enforces min spacing; jitter within ±20%.
- 100 targets due simultaneously (post-wake) → spread across interval, no
  stampede; fairness within 10% across products/locations.
- Backoff increases on 429; half-open probe; closes on success.

### 3.4 Recovery scenarios (FR-R, §2 matrix)
- Offline → no fetches, one in/one out event, resume with re-spread.
- Circuit-breaker open/half-open/close lifecycle.
- Kill -9 mid-check → restart → resume, no data loss, no dup alert.
- Session expiry → degrade + notify once + re-login resumes.

### 3.5 Adapter signal extraction (R2)
For each platform, a fixture per availability state (AVAILABLE, OUT_OF_STOCK,
UNAVAILABLE_IN_AREA, COMING_SOON/PREORDER where applicable, NOT_LISTED,
TEMPORARILY_UNAVAILABLE, plus a deliberately malformed/unknown-layout fixture)
→ asserts the correct 9-state verdict and confidence band. The malformed
fixture must yield `UNKNOWN`, never a commercial state.

### 3.6 Alert pipeline & channels (FR-AL)
- Multi-channel dispatch: all channels attempted; one failing channel does not
  block others; per-channel retry with backoff; delivery outcomes persisted.
- Alert payload completeness: product, platform, location, price, timestamp,
  state, link, confidence all present.
- Quiet hours suppress desktop/sound but still record + (configurably) email.

### 3.7 Storage (FR-R, R6, R13)
- Migrations apply idempotently; schema version tracked.
- WAL crash-safety: simulated mid-transaction abort leaves consistent DB.
- Retention prune archives then deletes; transitions/alerts retained.
- JSON fallback driver passes the same storage contract suite as SQLite.

## 4. Test infrastructure

- **FakeClock** implementing the `Clock` port — advance time deterministically;
  all timeouts/intervals/backoff read the clock, never `Date.now()` directly.
- **ScriptedAdapter** — returns a programmed sequence of Observations for
  engine tests without touching the network.
- **FakeChannel** — records dispatches, can be told to fail N times to exercise
  retry.
- **InMemoryStorage** — the JSON fallback driver, used to run the storage
  contract suite fast; the SQLite driver runs the same suite.
- **Fixtures** — captured/synthetic HTML+JSON per platform under
  `tests/fixtures/<platform>/<state>.*`, each annotated with provenance.

## 5. CI & quality gates

- `npm test` (Vitest) + `npm run typecheck` + `npm run lint` must pass.
- A GitHub Actions `SessionStart`-friendly workflow runs typecheck + unit tests
  on push.
- Coverage thresholds enforced on `src/core` and `src/alerts`.
- New adapter PRs must include fixtures for every state or the conformance
  suite fails.

## 6. What we explicitly do NOT test automatically

- Live platform requests (flaky, ToS-sensitive, non-deterministic). Real-site
  verification is a manual, human-cadence spot check documented in the
  maintenance guide, feeding new fixtures back into the suite.
- Actual desktop notification/sound rendering (OS-dependent) — smoke-checked
  manually; the dispatch logic is unit-tested via FakeChannel.
