# Stock Sentinel — Development Roadmap

**Document status:** Approved baseline (v1.0)

Reliability-first ordering: the deterministic core and its tests come before any
network code, so the false-positive controls are proven before a single real
request is made. Adapters are additive; the UI wraps a working engine.

## Milestone 0 — Foundations (repo, tooling)
- TypeScript project, Vitest, ESLint, strict tsconfig, scripts.
- Domain types (`src/core/types.ts`): 9 states, Observation, Target, Signal,
  Money, ports (Clock, Storage, PlatformAdapter, AlertChannel, NetworkProbe).
- **Exit:** `npm run typecheck && npm test` green on an empty suite.

## Milestone 1 — Deterministic core engine ✅ (highest priority)
- State machine (hysteresis, flap damping, ERROR/UNKNOWN overlays).
- Confidence model (signal weighting → verdict).
- Scheduler (fair due-selection, spread/jitter) + token-bucket rate limiter +
  circuit breaker.
- Dedup ledger.
- Engine orchestration loop over ports (no real I/O).
- FakeClock, ScriptedAdapter, FakeChannel, InMemoryStorage test doubles.
- **Exit:** all core + scenario tests in test-strategy §3.1–3.4 pass.

## Milestone 2 — Persistence & infrastructure
- SQLite storage (WAL, migrations, retention) implementing the Storage port.
- JSON fallback driver passing the same contract suite.
- Structured logger (rotating), net probe.
- **Exit:** storage contract suite green on both drivers; crash-safety test.

## Milestone 3 — Alert system
- Validator (confirmation orchestration), dedup integration, dispatcher.
- Channels: desktop notification, sound, email (SMTP), WhatsApp (gateway).
- **Exit:** alert pipeline tests (§3.6) pass; payload completeness enforced.

## Milestone 4 — Platform adapters (one at a time, fixture-first)
Order by signal cleanliness (easiest/most-reliable first, to validate the
adapter contract early):
1. **BigBasket** — explicit `avail_status=="001"` in SSR `__NEXT_DATA__`.
2. **Blinkit** — clean JSON `inventory`/`is_sold_out`.
3. **Zepto** — JSON + per-store context.
4. **Instamart** — JSON + WAF-stub UNKNOWN handling.
5. **Flipkart** — text markers + JSON-LD cross-check.
6. **Amazon** — buy-button + `#availability` conjunction.
- Each: manifest + adapter + signals + fixtures for every state + conformance.
- **Exit:** all six pass the adapter conformance + signal-extraction suites.

## Milestone 5 — Electron shell & UI
- Main-process engine host, typed IPC, tray, auto-launch, session windows.
- Renderer screens: Dashboard, Products, Platforms, Locations, Alerts, History,
  Profiles, Settings, Logs, Help, About.
- **Exit:** smoke checklist; add-product→check→state visible end to end.

## Milestone 6 — Hardening & soak
- 30-day compressed soak simulation (100 targets, mock adapters).
- Memory/handle audits; retention/VACUUM; diagnostics bundle.
- Responsible-use disclosures; accessibility pass.
- **Exit:** acceptance criteria (requirements §6) all met.

## Post-v1 (future)
- Price-history analytics & deal scoring.
- Additional platforms (Croma, Reliance Digital, Nykaa, Myntra, Apple Store,
  ticketing) via the integration guide.
- Optional encrypted cloud backup / multi-device.
- Mobile companion for alerts.

---

## Status in this repository

This repository delivers the full design documentation set (Phases 1–4 +
deliverables 1–12, 14–16) and a **working, tested implementation of Milestones
0–4** — the deterministic core engine, persistence, the alert pipeline, and the
six platform adapters with fixture-backed signal extraction — plus the Electron
main-process host and IPC surface (Milestone 5 scaffolding). The renderer UI is
specified in detail (docs/04-ux-design.md) and stubbed; wiring every screen is
the remaining implementation work and is tracked as Milestone 5 completion.
The engine and adapters run headless and are exercised by the automated test
suite, which is the reliability-critical surface.
