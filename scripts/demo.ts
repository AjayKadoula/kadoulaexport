/**
 * End-to-end scenario demo (no network, no Electron).
 *
 * Runs the REAL MonitoringService — real engine, real state machine, real alert
 * pipeline, real SQLite/JSON storage — against a scripted AdapterRuntime that
 * plays out a realistic timeline on Flipkart (a DOM platform whose readings are
 * confidence-capped, so the engine's confirmation logic is exercised):
 *
 *   out of stock  ->  a single flaky "available" blip that reverts on the
 *   confirmation re-check (NO alert)  ->  a genuine confirmed restock (ALERT)
 *   ->  still available (NO duplicate)  ->  a price drop (price-change ALERT)
 *   ->  an internet outage + recovery (no ERROR spam)  ->  a simulated app
 *   restart proving persistence + cross-restart dedup (NO re-alert).
 *
 * Run with:  npm run demo
 */

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as fs from 'node:fs';
import { AlertChannel, Alert, Clock, NetworkProbe, PlatformId } from '../src/core/types';
import { MonitoringService } from '../src/app/service';
import { AdapterRuntime, RawContent } from '../src/adapters/runtime';
import { createStorage } from '../src/infra/storage/factory';
import { createLogger } from '../src/infra/log';

const START = Date.UTC(2026, 6, 15, 8, 0, 0);

class DemoClock implements Clock {
  private t = START;
  now(): number { return this.t; }
  sleep(): Promise<void> { return Promise.resolve(); }
  advanceMinutes(m: number): void { this.t += m * 60_000; }
  minutes(): number { return (this.t - START) / 60_000; }
  iso(): string { return new Date(this.t).toISOString().replace('T', ' ').slice(0, 19); }
}

class Net implements NetworkProbe {
  online = true;
  async isOnline(): Promise<boolean> { return this.online; }
}

class ConsoleChannel implements AlertChannel {
  readonly name = 'desktop' as const;
  readonly enabled = true;
  count = 0;
  async send(a: Alert): Promise<void> {
    this.count++;
    console.log(`\n  🔔 ALERT #${this.count} ${'-'.repeat(48)}`);
    console.log(`     ${a.productName} — ${a.state} on ${a.platformId} @ ${a.pincode}`);
    console.log(`     price=${a.price ? '₹' + a.price.minor / 100 : '—'}  confidence=${a.confidenceLevel}  reason=${a.reason}`);
    console.log(`     ${a.url ?? ''}`);
    console.log(`  ${'-'.repeat(56)}`);
  }
}

/** Flipkart HTML for our watched product, varying with the clock. */
class ScriptedRuntime implements AdapterRuntime {
  constructor(private readonly clock: DemoClock) {}

  async ensureLocation() { return { applied: true, serviceable: true }; }
  async probeSession() { return { loggedIn: false, locationApplied: true, healthy: true }; }
  async search() { return { kind: 'html', html: '', finalUrl: '' } as RawContent; }

  async loadProduct(platform: PlatformId): Promise<RawContent> {
    const m = this.clock.minutes();
    if (platform !== 'flipkart') return this.fk(false);
    // 0–60 min (08:00–09:00): out of stock
    if (m < 60) return this.fk(false);
    // 60–65 min (09:00–09:05): a single flaky "available" blip
    if (m >= 60 && m < 65) return this.fk(true);
    // 65–120 min (09:05–10:00): back to out of stock (blip was false)
    if (m >= 65 && m < 120) return this.fk(false);
    // 120–240 min (10:00–12:00): genuine restock, stable
    if (m >= 120 && m < 240) return this.fk(true);
    // 240+ (12:00+): still available, price drops
    return this.fk(true, 129900);
  }

  private fk(inStock: boolean, price = 134900): RawContent {
    const ld = `<script type="application/ld+json">${JSON.stringify({
      '@type': 'Product',
      offers: { '@type': 'Offer', availability: `https://schema.org/${inStock ? 'InStock' : 'OutOfStock'}` },
    })}</script>`;
    const body = inStock
      ? `<div class="dyC4hf">₹${price.toLocaleString('en-IN')}</div><button>Add to Cart</button><button>Buy Now</button>`
      : `<div>Currently out of stock</div>`;
    return { kind: 'html', finalUrl: 'https://www.flipkart.com/apple-iphone-17-pro-max/p/itm?pid=MOBIP17PM', html: `<html><body>${ld}${body}</body></html>` };
  }
}

async function drive(service: MonitoringService, clock: DemoClock, minutes: number, stepMin = 5): Promise<void> {
  for (let elapsed = 0; elapsed < minutes; elapsed += stepMin) {
    clock.advanceMinutes(stepMin);
    for (const t of service.getTargets()) t.nextDueAt = clock.now();
    // eslint-disable-next-line no-await-in-loop
    await service.engine.tick();
  }
}

function printStates(service: MonitoringService, clock: DemoClock): void {
  for (const t of service.getTargets()) {
    console.log(`     [${clock.iso()}] ${t.platformId}@${t.pincode}: state=${t.state} last=${t.lastCommercialState} health=${t.health} price=${t.lastPrice ? '₹' + t.lastPrice.minor / 100 : '—'}`);
  }
}

function assert(cond: boolean, msg: string): void {
  if (!cond) { console.error(`\n  ✗ ASSERTION FAILED: ${msg}\n`); process.exitCode = 1; }
  else console.log(`     ✓ ${msg}`);
}

async function main(): Promise<void> {
  const dataDir = join(tmpdir(), `stock-sentinel-demo-${process.pid}`);
  if (fs.existsSync(dataDir)) fs.rmSync(dataDir, { recursive: true, force: true });
  fs.mkdirSync(dataDir, { recursive: true });

  const clock = new DemoClock();
  const net = new Net();
  const runtime = new ScriptedRuntime(clock);
  const channel = new ConsoleChannel();
  const logger = createLogger({ now: () => clock.now(), minLevel: 'error' });
  const { storage, driver } = createStorage({ sqlitePath: join(dataDir, 'data.sqlite'), jsonPath: join(dataDir, 'data.json') });

  console.log(`\n=== Stock Sentinel — end-to-end scenario demo ===`);
  console.log(`storage driver: ${driver}\n`);

  const service = new MonitoringService({ storage, runtime, channels: [channel], clock, netProbe: net, logger });
  service.restore();

  service.addLocation({ pincode: '122001', label: 'Home', enabled: true });
  for (const id of ['amazon', 'blinkit', 'zepto', 'instamart', 'bigbasket'] as PlatformId[]) service.setPlatformEnabled(id, false);
  service.setPlatformEnabled('flipkart', true);
  service.addProduct({
    id: 'iphone17pm',
    name: 'iPhone 17 Pro Max',
    mode: 'url',
    enabled: true,
    urls: { flipkart: 'https://www.flipkart.com/apple-iphone-17-pro-max/p/itm?pid=MOBIP17PM' },
  });
  console.log(`[${clock.iso()}] configured 1 product × flipkart × 122001 -> ${service.getTargets().length} target`);

  console.log(`\n--- Phase 1: out of stock (08:00–09:00) ---`);
  await drive(service, clock, 60);
  printStates(service, clock);
  assert(channel.count === 0, 'no alert while out of stock');

  console.log(`\n--- Phase 2: a flaky "available" blip that reverts on confirmation ---`);
  await drive(service, clock, 55); // 09:00 blip, then reverts by 09:05
  assert(channel.count === 0, 'flaky blip did NOT produce a false alert (confirmation caught it)');
  printStates(service, clock);

  console.log(`\n--- Phase 3: genuine confirmed restock (10:00+) -> ALERT ---`);
  await drive(service, clock, 60);
  assert(channel.count === 1, 'exactly one restock alert after confirmation');
  printStates(service, clock);

  console.log(`\n--- Phase 4: still available on later checks -> NO duplicate ---`);
  const before = channel.count;
  await drive(service, clock, 60);
  assert(channel.count === before, 'no duplicate alert while state is unchanged');

  console.log(`\n--- Phase 5: price drop ₹1,34,900 -> ₹1,29,900 -> price-change ALERT ---`);
  await drive(service, clock, 30);
  assert(channel.count === before + 1, 'one price-change alert on significant drop');
  printStates(service, clock);

  console.log(`\n--- Phase 6: internet outage then recovery (no ERROR spam) ---`);
  net.online = false;
  await drive(service, clock, 20);
  assert(service.engine.isOffline(), 'engine entered offline mode (no per-target errors)');
  net.online = true;
  await drive(service, clock, 10);
  assert(!service.engine.isOffline(), 'engine auto-resumed when connectivity returned');

  console.log(`\n--- Phase 7: simulate app restart -> resume from disk, no re-alert ---`);
  const firstRunAlerts = channel.count;
  await service.stop();
  storage.close();
  const { storage: storage2 } = createStorage({ sqlitePath: join(dataDir, 'data.sqlite'), jsonPath: join(dataDir, 'data.json') });
  const channel2 = new ConsoleChannel();
  const service2 = new MonitoringService({ storage: storage2, runtime, channels: [channel2], clock, netProbe: net, logger });
  service2.restore();
  for (const t of service2.getTargets()) t.nextDueAt = clock.now();
  await service2.engine.tick();
  assert(service2.getTargets().length === 1, 'targets restored from disk after restart');
  assert(channel2.count === 0, 'no re-alert after restart for an already-alerted edge (cross-restart dedup)');
  printStates(service2, clock);

  storage2.close();
  console.log(`\n=== demo complete: ${firstRunAlerts} alert(s), false-positive/dedup/recovery all verified ===\n`);
  fs.rmSync(dataDir, { recursive: true, force: true });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
