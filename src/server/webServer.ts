/**
 * Headless web-UI server. Hosts the real MonitoringService and serves a live
 * dashboard + JSON API over HTTP using only Node built-ins (no web framework).
 *
 * This is how Stock Sentinel runs and is *observed* in a headless environment
 * (no desktop). The desktop build renders the same data in an Electron window;
 * this renders it in a browser. The engine, adapters, storage, and alert
 * pipeline underneath are exactly the production ones.
 */

import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { MonitoringService } from '../app/service';
import { Storage } from '../infra/storage/types';
import { AdapterRuntime } from '../adapters/runtime';
import { SystemClock } from '../infra/clock';
import { AlwaysOnlineProbe } from '../infra/netProbe';
import { createLogger } from '../infra/log';
import { AlertChannel, Alert, formatMoney, PlatformId } from '../core/types';
import { ALL_PLATFORM_IDS, MANIFESTS } from '../adapters/registry';
import { dashboardHtml } from './dashboard';
import { isValidPincode } from '../app/materialize';

export interface WebServerOptions {
  storage: Storage;
  runtime: AdapterRuntime;
  port: number;
  host?: string;
  tickIntervalMs?: number;
  /** Additional real channels (desktop/sound/email/whatsapp) for the desktop app. */
  extraChannels?: AlertChannel[];
}

/** In-memory alert feed the dashboard reads. */
class FeedChannel implements AlertChannel {
  readonly name = 'desktop' as const;
  readonly enabled = true;
  readonly feed: Alert[] = [];
  async send(a: Alert): Promise<void> {
    this.feed.unshift(a);
    if (this.feed.length > 50) this.feed.pop();
  }
}

export class WebServer {
  private readonly service: MonitoringService;
  private readonly feed = new FeedChannel();
  private readonly clock = new SystemClock();
  private server = createServer((req, res) => this.handle(req, res));

  constructor(private readonly opts: WebServerOptions) {
    const logger = createLogger({ now: () => this.clock.now(), minLevel: 'info' });
    this.service = new MonitoringService({
      storage: opts.storage,
      runtime: opts.runtime,
      channels: [this.feed, ...(opts.extraChannels ?? [])],
      clock: this.clock,
      netProbe: new AlwaysOnlineProbe(),
      logger,
    });
  }

  async start(): Promise<{ url: string }> {
    this.service.restore();
    await this.service.start(this.opts.tickIntervalMs ?? 3000);
    const host = this.opts.host ?? '127.0.0.1';
    await new Promise<void>((resolve) => this.server.listen(this.opts.port, host, resolve));
    return { url: `http://${host}:${this.opts.port}` };
  }

  async stop(): Promise<void> {
    await this.service.stop();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    this.opts.storage.close();
  }

  getService(): MonitoringService {
    return this.service;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (req.method === 'GET' && url.pathname === '/') {
        return send(res, 200, 'text/html', dashboardHtml());
      }
      if (req.method === 'GET' && url.pathname === '/api/state') {
        return send(res, 200, 'application/json', JSON.stringify(this.stateJson()));
      }
      if (req.method === 'POST' && url.pathname === '/api/products') {
        const body = await readJson(req);
        return this.addProduct(res, body);
      }
      if (req.method === 'POST' && url.pathname === '/api/locations') {
        const body = await readJson(req);
        return this.addLocation(res, body);
      }
      if (req.method === 'POST' && url.pathname === '/api/platforms') {
        const body = await readJson(req);
        return this.togglePlatform(res, body);
      }
      send(res, 404, 'text/plain', 'not found');
    } catch (err) {
      send(res, 500, 'text/plain', `error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private addProduct(res: ServerResponse, body: Record<string, unknown>): void {
    const name = String(body.name ?? '').trim();
    if (!name) return send(res, 400, 'application/json', JSON.stringify({ error: 'name required' }));
    const mode = body.url ? 'url' : 'keyword';
    const id = `p_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
    this.service.addProduct({
      id,
      name,
      mode,
      enabled: true,
      keywords: mode === 'keyword' ? [name] : undefined,
      urls: mode === 'url' ? inferUrls(String(body.url)) : undefined,
    });
    send(res, 200, 'application/json', JSON.stringify({ ok: true, id }));
  }

  private addLocation(res: ServerResponse, body: Record<string, unknown>): void {
    const pincode = String(body.pincode ?? '').trim();
    if (!isValidPincode(pincode)) {
      return send(res, 400, 'application/json', JSON.stringify({ error: 'invalid pincode (need 6 digits, first 1-9)' }));
    }
    this.service.addLocation({ pincode, label: String(body.label ?? '') || undefined, enabled: true });
    send(res, 200, 'application/json', JSON.stringify({ ok: true }));
  }

  private togglePlatform(res: ServerResponse, body: Record<string, unknown>): void {
    const id = String(body.id ?? '') as PlatformId;
    if (!ALL_PLATFORM_IDS.includes(id)) {
      return send(res, 400, 'application/json', JSON.stringify({ error: 'unknown platform' }));
    }
    this.service.setPlatformEnabled(id, Boolean(body.enabled));
    send(res, 200, 'application/json', JSON.stringify({ ok: true }));
  }

  private stateJson(): unknown {
    const dash = this.service.getDashboard();
    const targets = dash.targets.map((t) => ({
      id: t.id,
      product: t.productId,
      platform: t.platformId,
      pincode: t.pincode,
      state: t.state,
      lastCommercial: t.lastCommercialState,
      health: t.health,
      price: formatMoney(t.lastPrice),
      lastChecked: t.lastCheckedAt,
      nextDue: t.nextDueAt,
    }));
    return {
      offline: dash.offline,
      now: this.clock.now(),
      platforms: ALL_PLATFORM_IDS.map((id) => ({ id, name: MANIFESTS[id].name, minSpacingS: MANIFESTS[id].minSpacingS })),
      targets,
      alerts: this.feed.feed.map((a) => ({
        product: a.productName,
        platform: a.platformId,
        pincode: a.pincode,
        state: a.state,
        reason: a.reason,
        price: formatMoney(a.price),
        confidence: a.confidenceLevel,
        url: a.url,
        at: a.at,
      })),
    };
  }
}

function inferUrls(url: string): Record<string, string> {
  const map: Record<string, string> = {};
  if (/amazon\./i.test(url)) map.amazon = url;
  else if (/flipkart\./i.test(url)) map.flipkart = url;
  else if (/blinkit\./i.test(url)) map.blinkit = url;
  else if (/zepto/i.test(url)) map.zepto = url;
  else if (/swiggy/i.test(url)) map.instamart = url;
  else if (/bigbasket/i.test(url)) map.bigbasket = url;
  return map;
}

function send(res: ServerResponse, code: number, type: string, body: string): void {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
}

function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e6) reject(new Error('payload too large'));
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new Error('invalid json'));
      }
    });
    req.on('error', reject);
  });
}
