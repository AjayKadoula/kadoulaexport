# Stock Sentinel — Future Platform Integration Guide

How to add a **seventh platform** (Croma, Reliance Digital, Nykaa, Apple Store,
a ticketing site, …). The engine never changes; you add one self-contained
adapter and register it. Budget: a focused day, most of it discovery.

## Step 0 — Discovery first (do not skip)

Follow the same method as the existing reports in `docs/discovery/`. Answer, with
evidence:

1. **Location** — how is the delivery location/pincode set and stored? Does
   availability depend on it? One session per location or switchable?
2. **Auth** — does guest mode show availability? What does login add? Session
   persistence/expiry?
3. **Search & URLs** — stable product URL/ID? SPA or server-rendered? Any
   internal JSON the web app uses?
4. **Inventory** — exactly how are `AVAILABLE` / `OUT_OF_STOCK` /
   `UNAVAILABLE_IN_AREA` / `COMING_SOON` / `PREORDER` /
   `TEMPORARILY_UNAVAILABLE` / `NOT_LISTED` represented? Where's the price?
5. **Posture** — block behaviour, robots.txt, a polite interval.
6. **Strategy** — browser vs browser-API vs SSR/HTML; pick the most reliable.

Write `docs/discovery/<platform>.md`. **The truth signal you choose here is the
whole ballgame** — prefer structured/JSON/`__NEXT_DATA__` over DOM/CSS.

## Step 1 — Add the platform id

In `src/core/types.ts`, add the id to the `PlatformId` union:

```ts
export type PlatformId = 'amazon' | 'flipkart' | 'blinkit' | 'zepto'
  | 'instamart' | 'bigbasket' | 'croma';   // <- new
```

## Step 2 — Signal extractor (the important, testable part)

Create `src/adapters/croma/signals.ts` — a **pure** function
`extract(raw: RawContent): ExtractResult`. Rules that keep false positives at
zero (enforced by the shared invariants):

- Return `overrideState`/`overrideConfidence` when you have a definitive signal
  (an explicit API boolean), else return `signals` and let `decideVerdict` weigh
  them.
- **Empty / blocked / ambiguous ⇒ `UNKNOWN`** (use `AMBIGUOUS_EMPTY` /
  `BLOCK_SIGNATURE`), never OOS/AVAILABLE. (`guardSignals` in `base.ts` already
  handles runtime-flagged blocked/empty/login for you.)
- Keep `UNAVAILABLE_IN_AREA` distinct from `OUT_OF_STOCK`.
- For DOM platforms, require a **conjunction** (buy control **and** positive
  availability text, plus structured-data agreement if present) and cap
  AVAILABLE confidence below `directAlertConfidence` so the engine always
  confirms.

## Step 3 — Manifest + adapter

Create `src/adapters/croma/adapter.ts`:

```ts
export const CROMA_MANIFEST: PlatformManifest = {
  id: 'croma', name: 'Croma', runtime: 'browser', // or 'browser-api' / 'http'
  locationStrategy: 'widget',        // pick from the LocationStrategy union
  guestBrowsingWorks: true,
  minSpacingS: 120,                  // >= 60; from discovery's polite interval
  defaultIntervalS: 600,
  alwaysConfirmAvailable: true,      // true for DOM/fragile signals
};

export class CromaAdapter implements PlatformAdapter {
  readonly manifest = CROMA_MANIFEST;
  constructor(private runtime: AdapterRuntime) {}
  async search(q, ctx) { /* resolve candidates (used once to find the product) */ }
  async check(target, ctx) {
    const raw = await this.runtime.loadProduct('croma', target, ctx.pincode);
    return observationFrom(raw, extractCroma, 0, 'browser', ctx.confirming);
  }
  async probeSession(ctx) { return this.runtime.probeSession('croma', ctx.pincode); }
  async ensureLocation(pin, ctx) { return this.runtime.ensureLocation('croma', pin, ctx.useAuthenticatedSession); }
}
```

## Step 4 — Register it

In `src/adapters/registry.ts` add the manifest to `MANIFESTS`, the id to
`ALL_PLATFORM_IDS`, and the adapter to `buildAdapters`. Add it to the
`PLATFORM_IDS` list in `src/core/engine.ts` if you want it scheduled (the engine
iterates a fixed list; extend it once).

## Step 5 — Playwright flow (production runtime)

In `src/adapters/playwright/runtime.ts`, extend `applyLocation`,
`loadProductContent`, and (if needed) `runSearch` / `internalEndpoint` with the
`'croma'` cases from your discovery. Keep the one-context-per-pincode rule.

## Step 6 — Fixtures + tests (the gate)

Add fixtures for **every** state your discovery found (plus a deliberately
malformed one) to `tests/fixtures/index.ts` under `croma`, and add `croma` to
`ALL_PLATFORM_IDS`-driven loops. The existing `tests/adapters.test.ts` will then
automatically:

- assert each fixture maps to its expected state,
- assert blocked/empty inputs never become AVAILABLE/OOS,
- assert AVAILABLE verdicts carry a positive signal,
- run the adapter conformance suite (manifest well-formed, `check`/
  `ensureLocation`/`probeSession` resolve).

Run `npm test && npm run typecheck`. Green means the platform is integrated
safely.

## Step 7 — Wire it into the UI

Nothing to do for the core dashboard — it renders all `ALL_PLATFORM_IDS`
dynamically (the Platforms toggles and target rows appear automatically). Add a
friendly name/icon in the UI theme if desired.

## Checklist

- [ ] Discovery report written with evidence + chosen strategy
- [ ] `PlatformId` extended
- [ ] Pure extractor with the safety rules
- [ ] Manifest (politeness floor from discovery) + adapter
- [ ] Registered in registry + engine platform list
- [ ] Playwright flow cases added
- [ ] Fixtures for every state + malformed
- [ ] `npm test` and `npm run typecheck` green
