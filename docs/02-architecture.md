# Stock Sentinel — Architecture Design

**Document status:** Approved baseline (v1.0)

---

## 1. Architecture overview

Stock Sentinel is a **local-first desktop application** built as an Electron
shell around a Node.js/TypeScript monitoring engine, with Playwright-driven
persistent browser contexts for platforms that require a real browser, and
SQLite for all persistence.

```mermaid
flowchart TB
    subgraph UI["Electron Renderer (UI)"]
        DASH[Dashboard]:::ui
        SCREENS[Products / Platforms / Locations / Alerts / History / Profiles / Settings / Logs]:::ui
    end

    subgraph MAIN["Electron Main Process — Engine Host"]
        IPC[IPC Bridge<br/>typed request/response + event push]
        ENGINE[Monitoring Engine<br/>scheduler · state machines · lifecycle]
        ALERTS[Alert Service<br/>validation · dedup · dispatch]
        SESS[Session Manager<br/>login windows · expiry detection]
        STORE[(SQLite WAL<br/>config · state · history)]
        LOGS[Structured Logger<br/>rotating files]
    end

    subgraph ADAPTERS["Platform Adapters (isolated per platform)"]
        AMZ[Amazon]
        FLP[Flipkart]
        BLK[Blinkit]
        ZPT[Zepto]
        SWG[Instamart]
        BB[BigBasket]
    end

    subgraph RUNTIME["Fetch Runtimes"]
        HTTP[HTTP Client<br/>cookie jars per platform]
        PW[Playwright Chromium<br/>persistent context per platform]
    end

    UI <--> IPC
    IPC <--> ENGINE
    ENGINE --> ALERTS
    ENGINE <--> STORE
    ALERTS --> STORE
    ENGINE --> ADAPTERS
    SESS --> PW
    ADAPTERS --> HTTP
    ADAPTERS --> PW
    ALERTS --> EXT[Desktop notif · Sound · SMTP · WhatsApp gateway]
```

### 1.1 Key decisions and alternatives considered

| Decision | Chosen | Alternatives | Rationale |
|---|---|---|---|
| App shell | **Electron + TypeScript** | Tauri, Python+Qt, local web app + tray daemon | One language end-to-end (engine, adapters, UI); first-class Playwright and SQLite support; mature notification/tray/auto-launch APIs; non-technical-user installers (dmg/exe). Tauri would need a Rust core or sidecar for Playwright; Python+Qt packaging for non-technical users is weaker. Electron's RAM cost is acceptable given we run headless Chromium anyway. |
| Engine location | **Electron main process** | Separate daemon process | Simpler v1 lifecycle; engine is a pure library (`src/core`) with no Electron imports, so extracting it into a standalone daemon later is a packaging change, not a rewrite. |
| Fetch strategy | **Playwright persistent context is the primary runtime for every platform; a plain-HTTP fetch path is retained per-adapter only as a degraded fallback.** Discovery (docs/discovery/) showed all six need a real browser for reliability: Amazon's anti-bot returns 503/CAPTCHA to naive HTTP; Flipkart renders stock via JS and obfuscates/rotates CSS classes; Blinkit/Zepto/Instamart are SPAs with edge protection; BigBasket is a heavy SPA. | All-HTTP; mixed HTTP-first | All-HTTP fails on SPAs and gets blocked on Amazon/Flipkart, i.e. exactly the false-negatives/positives we must avoid. The adapter interface hides the runtime; the quick-commerce adapters use a **Playwright-bootstrap → internal-JSON-poll hybrid** (browser establishes location/store context + cookies, then the internal search API is polled through that context for a deterministic `inventory`/`outOfStock` truth signal), while Amazon/Flipkart render and read the product page directly. Cost (one Chromium, contexts pooled/recycled per platform×location, serialized) is acceptable and bounded by NFR-3. |
| Persistence | **SQLite (WAL)** | JSON files, LevelDB, Postgres | Crash-safe, queryable history (search/filter/export/retention), single file backup. JSON files can't support history queries at scale; Postgres is absurd for a desktop app. Native-module risk is mitigated by a storage interface with a JSON fallback driver used in tests. |
| Scheduling | **Central scheduler + per-platform serialized work queues with token-bucket rate limits and jitter** | Per-target timers, cron | Per-target timers stampede after wake-from-sleep; a central scheduler can enforce per-platform politeness (one in-flight request per platform), fairness, and coordinated back-off. |
| Availability decisions | **Evidence-based signal extraction → rule table per platform → 9-state verdict with confidence score** | Boolean in-stock parsing | Required by product; also the foundation of false-positive control (an alert needs both a state transition *and* confidence ≥ threshold, else confirmation re-check). |
| Alert dedup | **Persisted per-target state machine; alerts only on transition edges** | Time-window dedup | Time windows still re-alert on flapping; edge-triggered transitions with hysteresis (confirmation) are exact. |
| Session storage | **Playwright persistent context dirs per platform (+ serialized cookie jar for HTTP adapters)** | Extracting cookies into DB | Letting Chromium own its profile is the only robust way to keep localStorage/IndexedDB-based sessions (quick-commerce SPAs) alive; the DB stores only metadata (login state, last validated). |

### 1.2 Design principles applied

- **Hexagonal core.** `src/core` knows nothing about Electron, Playwright, or
  any platform. Ports: `PlatformAdapter`, `AlertChannel`, `Storage`, `Clock`,
  `NetworkProbe`. Everything else is an adapter. This is what makes the test
  strategy (deterministic engine tests with fake clock + scripted adapters)
  and future platform additions cheap.
- **Bulkheads.** Each platform runs in its own queue with its own circuit
  breaker; an exception, block, or hang (checks carry hard timeouts) in one
  platform cannot starve another.
- **Crash-only design.** The engine persists intent (targets + their schedule
  state) and results (observations/transitions) transactionally; recovery is
  simply "load and continue" — there is no special crash-recovery path to keep
  correct, restart *is* the recovery path.
- **Never guess.** Signal extraction produces evidence; the rule table maps
  evidence to a state only when the evidence is coherent. Anything else is
  `UNKNOWN` with the raw evidence stored for diagnosis.

---

## 2. Component architecture

```mermaid
flowchart LR
    subgraph core["src/core (pure, no I/O)"]
        TYPES[types.ts<br/>domain model]
        SM[stateMachine.ts<br/>9-state transitions + hysteresis]
        SCHED[scheduler.ts<br/>due-target selection, fairness]
        RL[rateLimiter.ts<br/>token bucket + jitter + backoff]
        CB[circuitBreaker.ts]
        ENG[engine.ts<br/>orchestration loop]
        CONF[confidence.ts<br/>evidence → verdict]
    end
    subgraph infra["src/infra"]
        DB[storage/sqlite.ts]
        JSONS[storage/jsonFallback.ts]
        LOG[log.ts]
        NET[netProbe.ts]
    end
    subgraph adapters["src/adapters"]
        BASE[adapter API + manifest]
        HTTPC[http runtime]
        PWC[playwright runtime<br/>context pool]
        A1[amazon] --- A2[flipkart] --- A3[blinkit] --- A4[zepto] --- A5[instamart] --- A6[bigbasket]
    end
    subgraph alerts["src/alerts"]
        VAL[validator]
        DED[dedup ledger]
        DISP[dispatcher]
        CH[channels: desktop/sound/email/whatsapp]
    end
    ENG --> SM & SCHED & RL & CB & CONF
    ENG --> BASE
    BASE --> HTTPC & PWC
    ENG --> VAL --> DED --> DISP --> CH
    ENG --> DB
    core -.ports.-> infra
```

### 2.1 The adapter contract

```ts
interface PlatformAdapter {
  readonly manifest: PlatformManifest;      // id, name, runtime, politeness defaults,
                                            // location strategy, auth capabilities
  /** Resolve a keyword to candidate products at a location (search). */
  search(q: SearchQuery, ctx: CheckContext): Promise<CandidateProduct[]>;
  /** Read availability for a resolved product/URL at a location. */
  check(target: ResolvedTarget, ctx: CheckContext): Promise<Observation>;
  /** Cheap probe used by session manager: is our session/location still valid? */
  probeSession(ctx: CheckContext): Promise<SessionProbe>;
  /** Apply/refresh a location on the underlying session (may be a no-op). */
  ensureLocation(pincode: string, ctx: CheckContext): Promise<LocationResult>;
}
```

`Observation` never contains a bare boolean. It contains:
`{ state: AvailabilityState, price?: Money, evidence: Signal[], confidence: 0..1, fetchedVia, url, at }`.

### 2.2 Monitor target model

```
Product (1) ──< ProductPlatformBinding (optional per-platform URL/ASIN/pid)
Profile  ──< selects >── Products, Platforms, Locations, AlertPolicy
Target = (productId, platformId, pincode)   // materialized, has:
   schedule state (nextDueAt, interval, backoffLevel)
   machine state (currentState, sinceAt, lastConfirmedAt, flapCount)
   resolution cache (resolved URL/productRef per platform+location)
```

---

## 3. Data flow

```mermaid
flowchart TD
    T[Scheduler: target due] --> Q{Platform queue free +\ntokens available +\ncircuit closed?}
    Q -- no --> RQ[requeue with jitter]
    Q -- yes --> L[ensureLocation<br/>only if location context stale]
    L --> F[fetch via adapter runtime<br/>hard timeout]
    F --> X[extract signals<br/>DOM/JSON/structured data]
    X --> V[verdict: state + confidence + evidence]
    V --> P[(persist Observation)]
    P --> M{State machine:<br/>transition edge?}
    M -- no --> N[update lastSeen, reschedule]
    M -- yes --> C{Alert-worthy transition\nAND confidence ≥ θ?}
    C -- "needs confirmation" --> RC[schedule confirmation re-check<br/>independent fetch, short delay]
    RC --> F
    C -- yes --> A[Alert pipeline:<br/>validate → dedup ledger → dispatch all channels]
    A --> P2[(persist Alert + delivery outcomes)]
    C -- no --> N
```

Key property: **the confirmation re-check re-enters the same pipeline** — it is
a normal fetch with a `confirming` flag, so it obeys the same politeness rules
and produces the same evidence records.

---

## 4. Availability state machine

```mermaid
stateDiagram-v2
    [*] --> UNKNOWN : target created
    UNKNOWN --> AVAILABLE : confirmed available
    UNKNOWN --> OUT_OF_STOCK
    UNKNOWN --> NOT_LISTED
    UNKNOWN --> UNAVAILABLE_IN_AREA
    OUT_OF_STOCK --> AVAILABLE : ALERT (restock)
    NOT_LISTED --> AVAILABLE : ALERT (new listing live)
    NOT_LISTED --> COMING_SOON : ALERT (listing appeared)
    COMING_SOON --> PREORDER : ALERT
    COMING_SOON --> AVAILABLE : ALERT (launch)
    PREORDER --> AVAILABLE : ALERT
    AVAILABLE --> OUT_OF_STOCK : info event (stock lost)
    AVAILABLE --> TEMPORARILY_UNAVAILABLE : info event
    TEMPORARILY_UNAVAILABLE --> AVAILABLE : ALERT (restock)
    UNAVAILABLE_IN_AREA --> AVAILABLE : ALERT (now serviceable)
    OUT_OF_STOCK --> UNAVAILABLE_IN_AREA : info event
    AVAILABLE --> AVAILABLE : price-change alert only if Δ ≥ threshold
    note right of UNKNOWN
        ERROR and UNKNOWN observations never
        change the last known real state;
        they set a health flag instead.
        N consecutive ERRORs => target degraded,
        user notified once (not per check).
    end note
```

Transition rules of note:

1. **Hysteresis into AVAILABLE.** Entering AVAILABLE from any non-available
   state requires either confidence ≥ 0.9 with strong evidence (e.g. buy-box +
   structured-data agreement) or two consecutive AVAILABLE observations
   (the confirmation re-check). This is the false-positive gate.
2. **ERROR/UNKNOWN are overlays, not states of the world.** They are recorded
   and surfaced as target health, but the "last known commercial state" is kept
   so that recovery does not generate a spurious "reappeared" alert.
3. **Flap damping.** If a target alternates AVAILABLE/OUT_OF_STOCK more than K
   times in an hour, alerts collapse into a single "volatile stock" alert with
   a cooldown.

---

## 5. Monitoring lifecycle

```mermaid
stateDiagram-v2
    [*] --> Initializing : app start
    Initializing --> Restoring : load config+state (SQLite)
    Restoring --> Running : targets rescheduled\n(spread over first interval, jittered)
    Running --> Paused : user pause / all-platform pause
    Paused --> Running : resume
    Running --> Offline : net probe fails
    Offline --> Running : connectivity restored\n(re-spread schedule, no stampede)
    Running --> Stopping : quit / stop
    Stopping --> [*] : flush + close contexts
    note right of Offline
        While Offline: no fetches, no ERROR spam,
        one history event in/out.
    end note
```

Per-target pause/resume simply toggles participation in the scheduler; state
machine state is preserved.

---

## 6. Sequence: keyword monitoring on a browser-runtime platform

```mermaid
sequenceDiagram
    participant S as Scheduler
    participant E as Engine
    participant B as Blinkit Adapter
    participant P as Playwright ctx (blinkit, pincode 122001)
    participant DB as SQLite
    participant AL as Alert Service

    S->>E: target due (iPhone 17 × blinkit × 122001)
    E->>B: check(target, ctx)
    B->>P: ensure context alive + location == 122001
    alt location stale
        B->>P: set location flow (address search)
        P-->>B: store context (dark store id)
    end
    B->>P: open cached product URL (or search if unresolved)
    P-->>B: rendered state / intercepted JSON
    B-->>E: Observation{state: AVAILABLE, conf 0.95, evidence[...]}
    E->>DB: persist observation
    E->>E: state machine: OUT_OF_STOCK -> AVAILABLE (edge)
    E->>B: confirming re-check (fresh navigation)
    B-->>E: Observation{state: AVAILABLE, conf 0.95}
    E->>AL: raise(transition, obs)
    AL->>AL: dedup ledger check (no alert for this edge yet)
    AL->>AL: dispatch desktop+sound+email+whatsapp (parallel, isolated)
    AL->>DB: alert + per-channel delivery outcomes
    E->>DB: transition committed
    E->>S: reschedule target (normal interval)
```

## 6b. Sequence: session expiry & re-auth

```mermaid
sequenceDiagram
    participant E as Engine
    participant A as Adapter
    participant SM as Session Manager
    participant U as User (UI)

    E->>A: check(target)
    A-->>E: Observation{state: ERROR, evidence:[LOGIN_WALL]}
    E->>SM: reportAuthFailure(platform)
    SM->>SM: probeSession() to confirm (not a one-off)
    SM->>U: notify once: "Zepto session expired" + [Re-login] action
    SM->>E: platform mode -> guest-if-possible else suspended
    U->>SM: clicks Re-login
    SM->>SM: open visible browser window on platform login page
    U->>SM: completes OTP login (app never touches credentials)
    SM->>SM: probeSession() green
    SM->>E: platform mode -> authenticated; resume targets
```

---

## 7. Alert pipeline (validation, dedup, dispatch)

```mermaid
flowchart LR
    T[Transition edge] --> V{confidence ≥ 0.9\nAND strong evidence?}
    V -- yes --> D
    V -- no --> R[confirmation re-check\n30–90s later, fresh fetch]
    R -- confirms --> D
    R -- contradicts --> K[record flap, no alert]
    D{Dedup ledger:\nedge already alerted?\ncooldown active?} -- clear --> DI[Dispatch]
    D -- duplicate --> K2[suppress, record]
    DI --> C1[Desktop] & C2[Sound] & C3[Email] & C4[WhatsApp]
    C1 & C2 & C3 & C4 --> O[(delivery outcomes,\nper-channel retry w/ backoff)]
```

The **dedup ledger** is persisted: key = (targetId, edgeType, stateEnteredAt).
A restart cannot re-fire an alert for an edge that was already dispatched,
because dispatch is recorded in the same transaction that commits the
transition.

Confidence model: each extracted signal carries a weight (structured data
`InStock` = strong; visible "Add to cart" enabled = strong; price present =
supporting; text heuristic match = weak). Verdict confidence is computed from
signal agreement; disagreement caps confidence at 0.5 → `UNKNOWN` unless a
platform rule resolves it.

---

## 8. Failure recovery workflow

```mermaid
flowchart TD
    F[Check failed] --> C{Classify}
    C -- network --> NP{Global net probe}
    NP -- offline --> OFF[Engine -> Offline mode\nno per-target errors]
    NP -- online --> PB[platform backoff level +1\nexponential, cap 1h]
    C -- HTTP 429/503/block signature --> PB2[circuit breaker opens\nhalf-open probe after cooldown]
    C -- parse/shape change --> UK[UNKNOWN verdict + evidence snapshot\nplatform 'degraded' after N in a row]
    C -- auth --> AU[Session manager flow §6b]
    C -- timeout/browser crash --> BR[recycle Playwright context\nretry once next cycle]
    PB & PB2 --> HO[half-open: single probe target]
    HO -- success --> CL[close circuit, restore interval,\nre-spread schedule]
    HO -- fail --> PB2
```

The full failure matrix (cause → detection → response → user visibility) lives
in `docs/05-risk-failure-analysis.md`.

---

## 9. Storage schema (SQLite)

```
products(id, name, mode, keywords_json, rules_json, group_name, enabled, created_at, ...)
product_bindings(product_id, platform_id, url, platform_ref, resolved_by, resolved_at)
locations(pincode PK, label, enabled)
platforms(id PK, enabled, settings_json, session_state, session_checked_at)
profiles(id, name, payload_json, active)
targets(id, product_id, platform_id, pincode, enabled, interval_s, next_due_at,
        backoff_level, state, state_since, last_confirmed_at, flap_count, health)
observations(id, target_id, at, state, confidence, price_minor, currency,
             url, fetched_via, evidence_json)          -- pruned by retention
transitions(id, target_id, at, from_state, to_state, observation_id, alerted)
alerts(id, transition_id, at, payload_json, confidence)
alert_deliveries(alert_id, channel, status, attempts, last_error, delivered_at)
events(id, at, kind, level, source, message, data_json)  -- lifecycle/errors/audit
settings(key PK, value_json)
```

WAL mode, `synchronous=NORMAL`, single writer (engine), foreign keys ON.
Retention job runs daily: prune observations > N days (archiving to
`archive/observations-YYYY-MM.jsonl.gz` first), keep transitions/alerts 1 year.

---

## 10. Politeness & human-like operation (engineering spec)

- One in-flight request per platform, ever (serialized queue).
- Token bucket per platform: default capacity 1, refill = platform manifest
  `minSpacingSeconds` (60–180 s depending on platform class).
- All intervals jittered ±20%; post-restart and post-offline schedules are
  **spread** across the first interval window, never simultaneous.
- Location switching minimised: scheduler groups a platform's due targets by
  pincode and drains one pincode's batch before switching (quick-commerce),
  bounded so no pincode starves.
- Sessions and caches reused; conditional requests (ETag/If-Modified-Since)
  used where servers honour them.
- Back-off on any block/ratelimit signal; **no retry storms**: a failed check
  consumes its slot and waits for the (backed-off) next cycle.
- No parallel identity tricks, no CAPTCHA solving, no fingerprint spoofing.

---

## 11. Extensibility: adding platform #7

1. `src/adapters/<name>/manifest.ts` — id, runtime (http|browser), politeness
   defaults, location strategy, auth model.
2. `src/adapters/<name>/adapter.ts` — implement the 4-method contract.
3. `src/adapters/<name>/signals.ts` — extraction rules + fixtures.
4. Register in `src/adapters/registry.ts`; add fixtures under
   `tests/fixtures/<name>/`; adapter conformance suite runs automatically.

See `docs/10-platform-integration-guide.md` for the full walkthrough.
