import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync, existsSync } from 'node:fs';
import { Storage } from '../src/infra/storage/types';
import { JsonStorage } from '../src/infra/storage/jsonStore';
import { SqliteStorage } from '../src/infra/storage/sqlite';
import { AvailabilityState, Product, Target } from '../src/core/types';
import { newTarget } from '../src/core/target';

function sampleProduct(): Product {
  return {
    id: 'p1',
    name: 'iPhone 17 Pro Max',
    mode: 'keyword',
    keywords: ['iphone 17 pro max'],
    rules: { mustInclude: ['pro max'], maxPriceMinor: 15_000_000 },
    enabled: true,
    group: 'launch',
  };
}

function sampleTarget(now: number): Target {
  return newTarget({ id: 't1', productId: 'p1', platformId: 'bigbasket', pincode: '560004', intervalS: 600, now });
}

/** The contract every driver must satisfy. */
function contract(name: string, make: () => Storage, cleanup?: () => void) {
  describe(`storage contract — ${name}`, () => {
    let s: Storage;
    beforeEach(() => {
      s = make();
      s.init();
    });
    afterEach(() => {
      s.close();
      cleanup?.();
    });

    it('round-trips products', () => {
      const p = sampleProduct();
      s.upsertProduct(p);
      expect(s.getProduct('p1')).toEqual(p);
      expect(s.listProducts()).toHaveLength(1);
      s.deleteProduct('p1');
      expect(s.getProduct('p1')).toBeUndefined();
    });

    it('round-trips platform settings and locations', () => {
      s.setPlatformSettings('amazon', { enabled: true, useAuthenticatedSession: false, intervalOverrideS: 300 });
      expect(s.getPlatformSettings('amazon')?.intervalOverrideS).toBe(300);
      s.upsertLocation({ pincode: '122001', label: 'Home', enabled: true });
      expect(s.listLocations()).toHaveLength(1);
    });

    it('persists and reloads target machine state', () => {
      const t = sampleTarget(1000);
      t.state = AvailabilityState.OUT_OF_STOCK;
      t.lastCommercialState = AvailabilityState.OUT_OF_STOCK;
      t.lastPrice = { minor: 13490000, currency: 'INR' };
      s.upsertTarget(t);
      const loaded = s.listTargets();
      expect(loaded).toHaveLength(1);
      expect(loaded[0]!.state).toBe(AvailabilityState.OUT_OF_STOCK);
      expect(loaded[0]!.lastPrice?.minor).toBe(13490000);
    });

    it('records observations and commits transitions atomically with dedup', () => {
      const t = sampleTarget(1000);
      s.upsertTarget(t);
      s.recordObservation('t1', {
        state: AvailabilityState.AVAILABLE,
        confidence: 0.95,
        signals: [],
        fetchedVia: 'ssr',
        at: 2000,
        price: { minor: 13490000, currency: 'INR' },
      });
      const transition = {
        id: 'tr1',
        targetId: 't1',
        at: 2000,
        from: AvailabilityState.OUT_OF_STOCK,
        to: AvailabilityState.AVAILABLE,
        reason: 'restock' as const,
        alertWorthy: true,
        observation: {
          state: AvailabilityState.AVAILABLE,
          confidence: 0.95,
          signals: [],
          fetchedVia: 'ssr' as const,
          at: 2000,
        },
      };
      const alert = {
        id: 'al1',
        transitionId: 'tr1',
        targetId: 't1',
        at: 2000,
        productName: 'iPhone 17 Pro Max',
        platformId: 'bigbasket' as const,
        pincode: '560004',
        state: AvailabilityState.AVAILABLE,
        reason: 'restock' as const,
        confidence: 0.95,
        confidenceLevel: 'high' as const,
      };
      s.commitTransition(transition, alert, [{ channel: 'desktop', status: 'sent', attempts: 1, at: 2000 }], 't1|restock|AVAILABLE|1000');
      expect(s.loadDedupKeys()).toContain('t1|restock|AVAILABLE|1000');
      expect(s.queryAlerts({}).map((a) => a.id)).toContain('al1');
      expect(s.queryTransitions({}).map((tr) => tr.id)).toContain('tr1');
    });

    it('stores and retrieves resolutions', () => {
      s.saveResolution('t1', { url: 'https://x/pd/1', platformRef: '1' });
      expect(s.getResolution('t1')?.platformRef).toBe('1');
    });

    it('queries alerts by platform and text', () => {
      const base = {
        transitionId: 'tr', targetId: 't1', at: 5000, pincode: '1',
        state: AvailabilityState.AVAILABLE, reason: 'restock' as const,
        confidence: 0.9, confidenceLevel: 'high' as const,
      };
      s.commitTransition(
        { id: 'trA', targetId: 't1', at: 5000, from: AvailabilityState.OUT_OF_STOCK, to: AvailabilityState.AVAILABLE, reason: 'restock', alertWorthy: true, observation: { state: AvailabilityState.AVAILABLE, confidence: 0.9, signals: [], fetchedVia: 'http', at: 5000 } },
        { ...base, id: 'a-amz', productName: 'GPU 5090', platformId: 'amazon' },
        undefined, undefined,
      );
      s.commitTransition(
        { id: 'trB', targetId: 't2', at: 6000, from: AvailabilityState.OUT_OF_STOCK, to: AvailabilityState.AVAILABLE, reason: 'restock', alertWorthy: true, observation: { state: AvailabilityState.AVAILABLE, confidence: 0.9, signals: [], fetchedVia: 'http', at: 6000 } },
        { ...base, id: 'a-flp', productName: 'Sneaker XZ', platformId: 'flipkart', at: 6000 },
        undefined, undefined,
      );
      expect(s.queryAlerts({ platformId: 'amazon' }).map((a) => a.id)).toEqual(['a-amz']);
      expect(s.queryAlerts({ text: 'sneaker' }).map((a) => a.id)).toEqual(['a-flp']);
    });

    it('records events and settings', () => {
      s.recordEvent({ at: 1, kind: 'lifecycle', level: 'info', source: 'engine', message: 'started' });
      expect(s.queryEvents({ text: 'start' })).toHaveLength(1);
      s.setSetting('retention', { observationDays: 30 });
      expect(s.getSetting<{ observationDays: number }>('retention')?.observationDays).toBe(30);
    });

    it('prunes observations by retention policy', () => {
      const now = 100_000_000;
      s.recordObservation('t1', { state: AvailabilityState.OUT_OF_STOCK, confidence: 0.9, signals: [], fetchedVia: 'http', at: now - 40 * 86_400_000 });
      s.recordObservation('t1', { state: AvailabilityState.OUT_OF_STOCK, confidence: 0.9, signals: [], fetchedVia: 'http', at: now - 1 * 86_400_000 });
      const res = s.runRetention({ observationDays: 30, transitionDays: 365, alertDays: 365 }, now);
      expect(res.observationsPruned).toBe(1);
    });
  });
}

contract('json (in-memory)', () => new JsonStorage());

const dbPath = join(tmpdir(), `ss-test-${process.pid}-${Math.random().toString(36).slice(2)}.sqlite`);
contract(
  'sqlite',
  () => new SqliteStorage(dbPath),
  () => {
    for (const suffix of ['', '-wal', '-shm']) {
      const f = dbPath + suffix;
      if (existsSync(f)) rmSync(f);
    }
  },
);
