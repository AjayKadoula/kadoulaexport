/**
 * Launch the headless web-UI server on an available port and seed it with a
 * demonstrative watch list so the dashboard shows live activity immediately.
 *
 *   npm run serve            # auto-pick a port from 4173 upward
 *   PORT=8080 npm run serve  # start scanning from 8080
 *
 * Stock Sentinel is normally a desktop (Electron) app; this headless mode runs
 * the exact same engine/adapters/storage and serves the dashboard over HTTP so
 * it can run and be viewed anywhere (servers, containers, remote sessions).
 */

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as fs from 'node:fs';
import { WebServer } from '../src/server/webServer';
import { SimulatedRuntime } from '../src/server/simRuntime';
import { PlaywrightRuntime } from '../src/adapters/playwright/runtime';
import { AdapterRuntime } from '../src/adapters/runtime';
import { createStorage } from '../src/infra/storage/factory';
import { findAvailablePort } from '../src/server/ports';
import { PlatformId } from '../src/core/types';

/**
 * RUNTIME=real (or --real) switches from the simulated runtime to the real
 * Playwright runtime: actual site checks, actual availability. Extra knobs:
 *   HEADLESS=false  show the browser windows
 *   PW_CHANNEL      browser channel (default 'chrome': BigBasket's edge blocks
 *                   the bundled Chromium but serves the installed Chrome;
 *                   falls back to bundled Chromium if not installed)
 */
async function main(): Promise<void> {
  const real = /^(real|live|playwright)$/i.test(String(process.env.RUNTIME ?? '')) || process.argv.includes('--real');
  const base = Number(process.env.PORT ?? 4173);
  const host = process.env.HOST ?? '127.0.0.1';
  const port = await findAvailablePort(base, 50, host);

  // Sim and real data must never share a store: fabricated demo states shown
  // under the real-monitoring banner would be indistinguishable from truth.
  // An explicit DATA_DIR therefore gets a per-mode subdirectory.
  const dataDir = process.env.DATA_DIR
    ? join(process.env.DATA_DIR, real ? 'real' : 'sim')
    : join(tmpdir(), real ? 'stock-sentinel-web-real' : 'stock-sentinel-web');
  fs.mkdirSync(dataDir, { recursive: true });
  const { storage, driver } = createStorage({
    sqlitePath: join(dataDir, 'data.sqlite'),
    jsonPath: join(dataDir, 'data.json'),
  });

  const runtime: AdapterRuntime = real
    ? new PlaywrightRuntime({
        userDataRoot: join(dataDir, 'browser'),
        now: () => Date.now(),
        headless: !/^(0|false|no)$/i.test(String(process.env.HEADLESS ?? '')),
        channel: process.env.PW_CHANNEL ?? 'chrome',
        navTimeoutMs: 45000,
      })
    : new SimulatedRuntime({ now: () => Date.now(), cyclePeriodS: 60 });
  const server = new WebServer({ storage, runtime, port, host, tickIntervalMs: 2000 });
  const { url } = await server.start();

  // Seed a demonstrative watch list only when nothing was ever configured.
  // (Gate on storage, not materialized targets: a user who disabled all
  // platforms has zero targets but must NOT be re-seeded/re-enabled.)
  const svc = server.getService();
  const nothingConfigured = storage.listProducts().length === 0 && storage.listLocations().length === 0;
  if (nothingConfigured && !real) {
    svc.addLocation({ pincode: '122001', label: 'Home', enabled: true });
    svc.addLocation({ pincode: '560004', label: 'Office', enabled: true });
    for (const id of ['amazon', 'flipkart', 'blinkit', 'zepto', 'instamart', 'bigbasket'] as PlatformId[]) {
      svc.setPlatformEnabled(id, id === 'flipkart' || id === 'blinkit' || id === 'bigbasket');
    }
    svc.addProduct({ id: 'iphone17pm', name: 'iPhone 17 Pro Max', mode: 'keyword', keywords: ['iphone 17 pro max'], enabled: true });
    svc.addProduct({ id: 'ps5pro', name: 'PlayStation 5 Pro', mode: 'keyword', keywords: ['ps5 pro'], enabled: true });
  }
  // Real mode: seed the four live-validated URL-mode watches (July 2026).
  // Note: quick-commerce checks run without a per-pincode location session in
  // this mode, so they reflect default/national availability (fine for
  // electronics; groceries may vary by store).
  if (nothingConfigured && real) {
    svc.addLocation({ pincode: '122001', label: 'Home', enabled: true });
    for (const id of ['amazon', 'flipkart', 'blinkit', 'zepto', 'instamart', 'bigbasket'] as PlatformId[]) {
      svc.setPlatformEnabled(id, ['amazon', 'flipkart', 'zepto', 'bigbasket'].includes(id));
    }
    svc.addProduct({ id: 'g57power', name: 'Moto G57 Power (Zepto)', mode: 'url', enabled: true,
      urls: { zepto: 'https://www.zepto.com/pn/motorola-g57-power-pantone-corsair-8gb-ram-128gb-storage/pvid/67dc173a-8981-4ef4-859f-b2869ad528c3' } });
    svc.addProduct({ id: 'oneplus15r', name: 'OnePlus 15R (Amazon)', mode: 'url', enabled: true,
      urls: { amazon: 'https://www.amazon.in/dp/B0FZSWZZW2' } });
    svc.addProduct({ id: 'vivot5x', name: 'vivo T5x 5G (Flipkart)', mode: 'url', enabled: true,
      urls: { flipkart: 'https://www.flipkart.com/vivo-t5x-5g-cyber-green-128-gb/p/itm7da8aa253e72b?pid=MOBHH69NM5ERRNFT' } });
    svc.addProduct({ id: 'iphone17e', name: 'iPhone 17e 256GB (BigBasket)', mode: 'url', enabled: true,
      urls: { bigbasket: 'https://www.bigbasket.com/pd/40364806/apple-iphone-17e-256gb-black-1-unit/' } });
  }

  console.log(`\n🟢 Stock Sentinel is running (${real ? 'REAL live monitoring' : 'simulated demo'} runtime)`);
  console.log(`   URL:     ${url}`);
  console.log(`   Port:    ${port}${port !== base ? ` (auto-selected; ${base} was busy)` : ''}`);
  console.log(`   Storage: ${driver} at ${dataDir}`);
  console.log(`   Targets: ${svc.getTargets().length} seeded`);
  console.log(`\n   Open the URL in a browser. The dashboard live-updates every ~2.5s.`);
  console.log(`   Press Ctrl+C to stop.\n`);

  const shutdown = async (): Promise<void> => {
    console.log('\nshutting down…');
    await server.stop();
    if (real) await (runtime as PlaywrightRuntime).close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
