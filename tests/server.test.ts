import { describe, it, expect, afterAll } from 'vitest';
import { WebServer } from '../src/server/webServer';
import { SimulatedRuntime } from '../src/server/simRuntime';
import { JsonStorage } from '../src/infra/storage/jsonStore';
import { findAvailablePort, isPortFree } from '../src/server/ports';

describe('port utilities', () => {
  it('finds a free port and reports it free', async () => {
    const port = await findAvailablePort(45000, 20);
    expect(port).toBeGreaterThanOrEqual(45000);
    expect(await isPortFree(port)).toBe(true);
  });
});

describe('web server', () => {
  let server: WebServer;

  afterAll(async () => {
    if (server) await server.stop();
  });

  it('serves the dashboard and a working JSON API on an available port', async () => {
    const port = await findAvailablePort(46000, 20);
    const storage = new JsonStorage(); // in-memory
    const runtime = new SimulatedRuntime({ now: () => Date.now(), cyclePeriodS: 30 });
    server = new WebServer({ storage, runtime, port, tickIntervalMs: 50 });
    const { url } = await server.start();
    expect(url).toContain(String(port));

    // dashboard HTML
    const html = await (await fetch(`${url}/`)).text();
    expect(html).toContain('Stock Sentinel');
    expect(html).toContain('id="targets"');

    // initial state
    let state = await (await fetch(`${url}/api/state`)).json();
    expect(state.targets).toHaveLength(0);
    expect(state.platforms).toHaveLength(6);

    // add location + platform + product via the API
    await fetch(`${url}/api/locations`, { method: 'POST', body: JSON.stringify({ pincode: '122001' }) });
    await fetch(`${url}/api/platforms`, { method: 'POST', body: JSON.stringify({ id: 'blinkit', enabled: true }) });
    await fetch(`${url}/api/products`, { method: 'POST', body: JSON.stringify({ name: 'iPhone 17 Pro Max', url: 'https://blinkit.com/prn/x/prid/1' }) });

    state = await (await fetch(`${url}/api/state`)).json();
    expect(state.targets.length).toBe(1);
    expect(state.targets[0].platform).toBe('blinkit');

    // invalid pincode rejected
    const bad = await fetch(`${url}/api/locations`, { method: 'POST', body: JSON.stringify({ pincode: '12' }) });
    expect(bad.status).toBe(400);

    // Targets are scheduled spread across their (600s) interval for politeness,
    // so force this one due, then let the running tick loop check it.
    for (const t of server.getService().getTargets()) t.nextDueAt = Date.now();
    await new Promise((r) => setTimeout(r, 400));
    state = await (await fetch(`${url}/api/state`)).json();
    expect(state.targets[0].lastChecked).toBeGreaterThan(0);
  });
});
