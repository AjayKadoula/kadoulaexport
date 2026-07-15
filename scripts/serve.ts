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
import { createStorage } from '../src/infra/storage/factory';
import { findAvailablePort } from '../src/server/ports';
import { PlatformId } from '../src/core/types';

async function main(): Promise<void> {
  const base = Number(process.env.PORT ?? 4173);
  const host = process.env.HOST ?? '127.0.0.1';
  const port = await findAvailablePort(base, 50, host);

  const dataDir = process.env.DATA_DIR ?? join(tmpdir(), 'stock-sentinel-web');
  fs.mkdirSync(dataDir, { recursive: true });
  const { storage, driver } = createStorage({
    sqlitePath: join(dataDir, 'data.sqlite'),
    jsonPath: join(dataDir, 'data.json'),
  });

  const runtime = new SimulatedRuntime({ now: () => Date.now(), cyclePeriodS: 60 });
  const server = new WebServer({ storage, runtime, port, host, tickIntervalMs: 2000 });
  const { url } = await server.start();

  // Seed a demonstrative watch list if empty, so the dashboard isn't blank.
  const svc = server.getService();
  if (svc.getTargets().length === 0) {
    svc.addLocation({ pincode: '122001', label: 'Home', enabled: true });
    svc.addLocation({ pincode: '560004', label: 'Office', enabled: true });
    for (const id of ['amazon', 'flipkart', 'blinkit', 'zepto', 'instamart', 'bigbasket'] as PlatformId[]) {
      svc.setPlatformEnabled(id, id === 'flipkart' || id === 'blinkit' || id === 'bigbasket');
    }
    svc.addProduct({ id: 'iphone17pm', name: 'iPhone 17 Pro Max', mode: 'keyword', keywords: ['iphone 17 pro max'], enabled: true });
    svc.addProduct({ id: 'ps5pro', name: 'PlayStation 5 Pro', mode: 'keyword', keywords: ['ps5 pro'], enabled: true });
  }

  console.log(`\n🟢 Stock Sentinel is running`);
  console.log(`   URL:     ${url}`);
  console.log(`   Port:    ${port}${port !== base ? ` (auto-selected; ${base} was busy)` : ''}`);
  console.log(`   Storage: ${driver} at ${dataDir}`);
  console.log(`   Targets: ${svc.getTargets().length} seeded`);
  console.log(`\n   Open the URL in a browser. The dashboard live-updates every ~2.5s.`);
  console.log(`   Press Ctrl+C to stop.\n`);

  const shutdown = async (): Promise<void> => {
    console.log('\nshutting down…');
    await server.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
