import { describe, it, expect } from 'vitest';
import { AvailabilityState, PlatformId } from '../src/core/types';
import { extractAmazon } from '../src/adapters/amazon/signals';
import { extractFlipkart } from '../src/adapters/flipkart/signals';
import { extractBlinkit } from '../src/adapters/blinkit/signals';
import { extractZepto } from '../src/adapters/zepto/signals';
import { extractInstamart } from '../src/adapters/instamart/signals';
import { extractBigBasket } from '../src/adapters/bigbasket/signals';
import { observationFrom } from '../src/adapters/base';
import { buildAdapters, MANIFESTS, ALL_PLATFORM_IDS } from '../src/adapters/registry';
import { FixtureRuntime, RawContent } from '../src/adapters/runtime';
import { ALL_FIXTURES, Fixture } from './fixtures';

const EXTRACTORS: Record<PlatformId, (r: RawContent) => ReturnType<typeof extractAmazon>> = {
  amazon: extractAmazon,
  flipkart: extractFlipkart,
  blinkit: extractBlinkit,
  zepto: extractZepto,
  instamart: extractInstamart,
  bigbasket: extractBigBasket,
};

describe('adapter signal extraction — every state per platform', () => {
  for (const platform of ALL_PLATFORM_IDS) {
    const fixtures = ALL_FIXTURES[platform];
    describe(platform, () => {
      for (const fx of fixtures as Fixture[]) {
        it(`${fx.name} -> ${fx.expected}`, () => {
          const obs = observationFrom(fx.raw, EXTRACTORS[platform], 1000, 'fake');
          expect(obs.state).toBe(fx.expected);
          // The critical safety invariant: an ambiguous/blocked/empty input is
          // NEVER reported as AVAILABLE or OUT_OF_STOCK.
          if (fx.raw.blocked || fx.raw.empty) {
            expect(obs.state).toBe(AvailabilityState.UNKNOWN);
          }
        });
      }
    });
  }
});

describe('false-positive safety across all fixtures', () => {
  it('no AVAILABLE verdict ever comes from a blocked/empty/stub input', () => {
    for (const platform of ALL_PLATFORM_IDS) {
      for (const fx of ALL_FIXTURES[platform] as Fixture[]) {
        if (fx.raw.blocked || fx.raw.empty) {
          const obs = observationFrom(fx.raw, EXTRACTORS[platform], 1, 'fake');
          expect(obs.state).not.toBe(AvailabilityState.AVAILABLE);
          expect(obs.state).not.toBe(AvailabilityState.OUT_OF_STOCK);
        }
      }
    }
  });

  it('AVAILABLE verdicts carry a supporting positive signal', () => {
    for (const platform of ALL_PLATFORM_IDS) {
      for (const fx of ALL_FIXTURES[platform] as Fixture[]) {
        const obs = observationFrom(fx.raw, EXTRACTORS[platform], 1, 'fake');
        if (obs.state === AvailabilityState.AVAILABLE) {
          const kinds = obs.signals.map((s) => s.kind);
          const hasPositive = kinds.some((k) =>
            ['API_IN_STOCK', 'STRUCTURED_IN_STOCK', 'BUY_CONTROL_PRESENT', 'TEXT_AVAILABLE'].includes(k),
          );
          expect(hasPositive).toBe(true);
        }
      }
    }
  });
});

describe('adapter conformance — the contract every platform satisfies', () => {
  // A fixture runtime returns the AVAILABLE fixture for any product lookup.
  const availableFixtures: Record<PlatformId, RawContent> = {
    amazon: ALL_FIXTURES.amazon[0]!.raw,
    flipkart: ALL_FIXTURES.flipkart[0]!.raw,
    blinkit: ALL_FIXTURES.blinkit[0]!.raw,
    zepto: ALL_FIXTURES.zepto[0]!.raw,
    instamart: ALL_FIXTURES.instamart[0]!.raw,
    bigbasket: ALL_FIXTURES.bigbasket[0]!.raw,
  };
  const runtime = new FixtureRuntime((_op, platform) => availableFixtures[platform]);
  const adapters = buildAdapters(runtime);

  for (const platform of ALL_PLATFORM_IDS) {
    it(`${platform}: manifest is well-formed`, () => {
      const m = MANIFESTS[platform];
      expect(m.id).toBe(platform);
      expect(m.minSpacingS).toBeGreaterThanOrEqual(60); // politeness floor
      expect(m.defaultIntervalS).toBeGreaterThanOrEqual(m.minSpacingS);
      expect(['browser', 'browser-api', 'http']).toContain(m.runtime);
    });

    it(`${platform}: check() returns a valid Observation`, async () => {
      const adapter = adapters.get(platform)!;
      const obs = await adapter.check(
        { productId: 'p', platformId: platform, pincode: '122001', url: 'https://x' },
        { pincode: '122001', useAuthenticatedSession: false },
      );
      expect(Object.values(AvailabilityState)).toContain(obs.state);
      expect(obs.confidence).toBeGreaterThanOrEqual(0);
      expect(obs.confidence).toBeLessThanOrEqual(1);
      expect(obs.state).toBe(AvailabilityState.AVAILABLE); // available fixture
    });

    it(`${platform}: ensureLocation and probeSession resolve`, async () => {
      const adapter = adapters.get(platform)!;
      await expect(
        adapter.ensureLocation('122001', { pincode: '122001', useAuthenticatedSession: false }),
      ).resolves.toHaveProperty('applied');
      await expect(
        adapter.probeSession({ pincode: '122001', useAuthenticatedSession: false }),
      ).resolves.toHaveProperty('healthy');
    });
  }
});
