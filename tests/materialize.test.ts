import { describe, it, expect } from 'vitest';
import { materialize, targetId, isValidPincode } from '../src/app/materialize';
import { AvailabilityState, Location, PlatformSettings, Product } from '../src/core/types';

const now = 1_000_000;

function platforms(...ids: string[]): Record<string, PlatformSettings> {
  const out: Record<string, PlatformSettings> = {};
  for (const id of ids) out[id] = { enabled: true, useAuthenticatedSession: false };
  return out;
}
const locations: Location[] = [
  { pincode: '122001', enabled: true },
  { pincode: '122002', enabled: true },
  { pincode: '000000', enabled: false }, // disabled
];

describe('target materialisation', () => {
  it('creates product × platform × location for keyword products', () => {
    const products: Product[] = [{ id: 'p1', name: 'iPhone', mode: 'keyword', keywords: ['iphone'], enabled: true }];
    const targets = materialize({ products, platforms: platforms('amazon', 'flipkart'), locations, now });
    // 1 product × 2 platforms × 2 enabled locations
    expect(targets).toHaveLength(4);
  });

  it('url-mode products only monitor platforms with a URL', () => {
    const products: Product[] = [
      { id: 'p1', name: 'X', mode: 'url', enabled: true, urls: { amazon: 'https://a' } },
    ];
    const targets = materialize({ products, platforms: platforms('amazon', 'flipkart'), locations, now });
    // only amazon has a URL -> 1 platform × 2 locations
    expect(targets).toHaveLength(2);
    expect(targets.every((t) => t.platformId === 'amazon')).toBe(true);
  });

  it('skips disabled products and platforms', () => {
    const products: Product[] = [
      { id: 'p1', name: 'X', mode: 'keyword', keywords: ['x'], enabled: false },
      { id: 'p2', name: 'Y', mode: 'keyword', keywords: ['y'], enabled: true },
    ];
    const plats = platforms('amazon');
    plats.flipkart = { enabled: false, useAuthenticatedSession: false };
    const targets = materialize({ products, platforms: plats, locations, now });
    expect(targets.every((t) => t.productId === 'p2')).toBe(true);
    expect(targets.every((t) => t.platformId === 'amazon')).toBe(true);
  });

  it('preserves existing target machine state across re-materialisation', () => {
    const products: Product[] = [{ id: 'p1', name: 'X', mode: 'keyword', keywords: ['x'], enabled: true }];
    const first = materialize({ products, platforms: platforms('amazon'), locations, now });
    const t = first[0]!;
    t.state = AvailabilityState.AVAILABLE;
    t.lastCommercialState = AvailabilityState.AVAILABLE;
    const existing = new Map(first.map((x) => [x.id, x]));
    const second = materialize({ products, platforms: platforms('amazon'), locations, now: now + 1000, existing });
    const same = second.find((x) => x.id === t.id)!;
    expect(same.state).toBe(AvailabilityState.AVAILABLE); // preserved
  });

  it('enforces the platform politeness floor on interval overrides', () => {
    const products: Product[] = [{ id: 'p1', name: 'X', mode: 'keyword', keywords: ['x'], enabled: true }];
    const plats = platforms('amazon');
    plats.amazon = { enabled: true, useAuthenticatedSession: false, intervalOverrideS: 5 }; // absurdly low
    const targets = materialize({ products, platforms: plats, locations, now });
    // amazon minSpacingS is 180 -> interval floored to >= 180
    expect(targets[0]!.intervalS).toBeGreaterThanOrEqual(180);
  });

  it('produces stable deterministic ids', () => {
    expect(targetId('p1', 'amazon', '122001')).toBe('p1::amazon::122001');
  });
});

describe('pincode validation', () => {
  it('accepts valid Indian pincodes', () => {
    expect(isValidPincode('122001')).toBe(true);
    expect(isValidPincode('560004')).toBe(true);
  });
  it('rejects invalid ones', () => {
    expect(isValidPincode('012345')).toBe(false); // leading 0
    expect(isValidPincode('12')).toBe(false);
    expect(isValidPincode('abcdef')).toBe(false);
    expect(isValidPincode('1234567')).toBe(false);
  });
});
