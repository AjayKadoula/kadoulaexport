# Stock Sentinel — Maintenance Guide

For maintainers keeping Stock Sentinel healthy over time. The single biggest
maintenance reality: **platforms change their pages and endpoints**, so adapter
detection needs occasional updates. The architecture is built to make that a
localised, test-covered change — never a firefight.

## 1. Where fragility lives (and doesn't)

- **Stable (rarely changes):** everything in `src/core` (state machine,
  scheduler, confidence, dedup), `src/alerts`, `src/infra`. These are pure and
  fixture/contract-tested.
- **Fragile (expect change):** the per-platform **signal extractors**
  (`src/adapters/<platform>/signals.ts`) and the **Playwright flows**
  (`src/adapters/playwright/runtime.ts`). Both are isolated so a change to one
  platform can't affect another.

Because verdict logic is pure and evidence-based, a broken selector produces
`UNKNOWN` (a visible "degraded" state), **not** a false alert. You get a safe
signal that maintenance is needed, not a user-facing bug.

## 2. Detecting that an adapter needs attention

Signals that a platform changed:
- The **Platforms** screen shows the platform "degraded" (N consecutive
  `UNKNOWN`/shape-mismatch checks).
- **Logs** contain `signal shape changed` / evidence snapshots for that
  platform.
- History shows a platform stuck in `UNKNOWN` while others behave.

Each `UNKNOWN` from a shape change stores the raw evidence, so you can see
exactly what the page/endpoint returned.

## 3. Fixing an adapter (the loop)

1. **Capture a fresh fixture.** Reproduce the current page/JSON for each state
   you can (in stock, out of stock, area-unavailable, etc.). Save it under
   `tests/fixtures/<platform>/` (or extend `tests/fixtures/index.ts`), annotated
   with the expected state.
2. **Update the extractor** in `src/adapters/<platform>/signals.ts` to read the
   new markers. Keep the discovery rules intact:
   - prefer structured/JSON truth over DOM/CSS,
   - empty/blocked/ambiguous ⇒ `UNKNOWN` (never OOS/AVAILABLE),
   - keep `UNAVAILABLE_IN_AREA` distinct from `OUT_OF_STOCK`.
3. **Run the adapter tests:** `npm test -- adapters`. The new fixtures must pass
   and the false-positive-safety invariants must hold.
4. **Update the Playwright flow** in `runtime.ts` only if navigation/location
   application changed (e.g. a new pincode widget selector).
5. **Update the discovery report** (`docs/discovery/`) with what changed and the
   date, so the evidence trail stays current.

The golden rule: **a real-world change should first appear as a failing test**,
which you make pass — not as a production incident.

## 4. Politeness & anti-block hygiene

- Never lower a platform's `minSpacingS` below the discovery-recommended floor.
- If a platform starts returning 403/429, the circuit breaker + back-off handle
  it automatically; don't add retries or parallelism to "get around" it.
- Keep one persistent browser context per (platform, pincode). Do not share
  location cookies across pincodes.
- Do not add CAPTCHA solving, fingerprint spoofing, or evasion — out of scope
  and self-defeating for a long-running personal monitor.

## 5. Data, retention, and backups

- Storage is SQLite (WAL) at the app's user-data dir (`stock-sentinel.sqlite`),
  with a JSON fallback if the native module is unavailable.
- Retention runs daily: raw observations pruned after `observationDays`
  (default 30, archived first); transitions/alerts kept a year. Tune in
  **Settings → Retention**.
- **Backup** = copy the single SQLite file (or export products/locations/
  profiles as JSON from the app). Restlessly safe to copy while stopped.
- If the DB is ever corrupted, the app fails over to the JSON store for the
  session and warns; restore from a backup when convenient.

## 6. Diagnostics

- **Logs screen** → open log folder; logs are rotating JSON lines (10 × 5 MB)
  with secrets/cookies redacted.
- **Copy diagnostics bundle** gathers recent logs + non-sensitive config for
  bug reports.
- Reproduce engine behaviour deterministically with the test doubles
  (`tests/helpers/fakes.ts`): `FakeClock`, `ScriptedAdapter`, `InMemoryStorage`.

## 7. Upgrades & releases

- Bump the schema `MIGRATIONS` array in `src/infra/storage/sqlite.ts` additively
  (never rewrite history); the version is tracked in `schema_version`.
- Run the full suite + `npm run typecheck` before release; coverage thresholds
  on `src/core` and `src/alerts` are enforced.
- Ship new/updated fixtures with any adapter change so the CI gate protects the
  detection.

## 8. Performance over weeks (the soak profile)

- Browser contexts recycle every ≤ 6 h (bounds memory).
- Observations are pruned on schedule (bounds disk).
- Logs rotate (bounds disk).
- Scheduling is monotonic and re-spreads after sleep/wake (no stampede).

The `tests/soak.test.ts` compressed 30-day simulation is the canary: if a change
breaks fairness, memory-boundedness, or introduces duplicate alerts, it fails.
