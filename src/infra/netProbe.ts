/**
 * Network connectivity probe. Used by the engine to enter Offline mode instead
 * of spamming per-target ERRORs during an internet outage. Debounced so a
 * single blip doesn't flap the engine offline/online.
 */

import { NetworkProbe } from '../core/types';

export type FetchLike = (url: string, init: { method: string; signal?: AbortSignal }) => Promise<{ ok: boolean }>;

export interface NetProbeOptions {
  /** Neutral hosts to check (any success => online). */
  hosts?: string[];
  timeoutMs?: number;
  fetchImpl?: FetchLike;
  /** Cache result for this long to avoid probing on every tick. */
  cacheMs?: number;
  now: () => number;
}

const DEFAULT_HOSTS = [
  'https://www.google.com/generate_204',
  'https://cloudflare.com/cdn-cgi/trace',
];

export class HttpNetworkProbe implements NetworkProbe {
  private cached?: { at: number; online: boolean };
  private readonly fetchImpl: FetchLike;

  constructor(private readonly opts: NetProbeOptions) {
    this.fetchImpl =
      opts.fetchImpl ??
      ((url, init) =>
        (globalThis.fetch as unknown as FetchLike)(url, init).then((r) => ({ ok: r.ok })));
  }

  async isOnline(): Promise<boolean> {
    const cacheMs = this.opts.cacheMs ?? 15_000;
    if (this.cached && this.opts.now() - this.cached.at < cacheMs) {
      return this.cached.online;
    }
    const online = await this.probe();
    this.cached = { at: this.opts.now(), online };
    return online;
  }

  private async probe(): Promise<boolean> {
    const hosts = this.opts.hosts ?? DEFAULT_HOSTS;
    const timeout = this.opts.timeoutMs ?? 4000;
    for (const host of hosts) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeout);
        // eslint-disable-next-line no-await-in-loop
        const res = await this.fetchImpl(host, { method: 'GET', signal: controller.signal });
        clearTimeout(timer);
        if (res.ok) return true;
      } catch {
        /* try next host */
      }
    }
    return false;
  }
}

/** Always-online probe for tests / offline-first config screens. */
export class AlwaysOnlineProbe implements NetworkProbe {
  async isOnline(): Promise<boolean> {
    return true;
  }
}
