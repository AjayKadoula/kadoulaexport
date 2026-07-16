/**
 * Production AdapterRuntime backed by Playwright (Chromium).
 *
 * Grounded in the discovery reports (docs/discovery/*): the reliable strategy
 * for every platform is a real browser. This runtime maintains ONE persistent
 * browser context per (platform, pincode) — a dedicated cookie jar per location
 * — which is the discovery study's central rule for correct multi-pincode
 * monitoring ("never hot-swap location cookies within a session"). Contexts are
 * recycled on a max-age to bound memory over weeks of running.
 *
 * Playwright is an optional dependency and this module is imported lazily by the
 * Electron host, so the core/tests never require a browser. The per-platform
 * location flows and content extraction hooks are intentionally isolated here;
 * the pure signal extractors in ../<platform>/signals.ts do the verdict work.
 *
 * NOTE: The precise DOM/endpoint interactions (e.g. Amazon's GLOW handshake,
 * Zepto's store_id resolution) are the fragile surface the discovery reports
 * flag as subject to change; they are encapsulated per platform below and are
 * expected to need occasional maintenance (see docs/maintenance.md).
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  LocationResult,
  PlatformId,
  ResolvedTarget,
  SessionProbe,
} from '../../core/types';
import { AdapterRuntime, RawContent } from '../runtime';
import { platformSearchUrl } from '../searchUrls';

/** How long to let a client-rendered search page paint before reading it. */
const SPA_RENDER_WAIT_MS = 4000;

// Minimal structural types so this file compiles without @types/playwright.
interface PwPage {
  goto(url: string, opts?: any): Promise<any>;
  content(): Promise<string>;
  waitForTimeout(ms: number): Promise<void>;
  evaluate<T>(fn: any, arg?: any): Promise<T>;
  fill(selector: string, value: string): Promise<void>;
  click(selector: string, opts?: any): Promise<void>;
  url(): string;
  close(): Promise<void>;
  $(selector: string): Promise<any>;
}
interface PwContext {
  newPage(): Promise<PwPage>;
  close(): Promise<void>;
  cookies(): Promise<any[]>;
  addCookies(cookies: any[]): Promise<void>;
}
interface PwBrowser {
  newContext(opts?: any): Promise<PwContext>;
  close(): Promise<void>;
}

interface ContextEntry {
  context: PwContext;
  createdAt: number;
  pincode: string;
}

export interface PlaywrightRuntimeOptions {
  userDataRoot: string;
  now: () => number;
  /** Recycle a context after this age (ms). Default 6h. */
  maxContextAgeMs?: number;
  navTimeoutMs?: number;
  headless?: boolean;
  /**
   * Playwright browser channel, e.g. 'chrome' to drive the machine's installed
   * Google Chrome. BigBasket's edge (Akamai) rejects the bundled Chromium
   * build outright but serves the real Chrome normally, so 'chrome' is the
   * recommended channel when it is installed. Falls back to bundled Chromium
   * if the channel is unavailable.
   */
  channel?: string;
}

export class PlaywrightRuntime implements AdapterRuntime {
  private browser: PwBrowser | null = null;
  private readonly contexts = new Map<string, ContextEntry>();
  private readonly maxAge: number;

  constructor(private readonly opts: PlaywrightRuntimeOptions) {
    this.maxAge = opts.maxContextAgeMs ?? 6 * 60 * 60 * 1000;
  }

  private async ensureBrowser(): Promise<PwBrowser> {
    if (this.browser) return this.browser;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { chromium } = require('playwright');
    const base = { headless: this.opts.headless ?? true };
    if (this.opts.channel) {
      try {
        this.browser = (await chromium.launch({ ...base, channel: this.opts.channel })) as PwBrowser;
        return this.browser;
      } catch (err) {
        // Falling back silently would hide edge-blocking consequences (e.g.
        // BigBasket 403s the bundled Chromium) — make the downgrade visible.
        // eslint-disable-next-line no-console
        console.warn(
          `[playwright] channel '${this.opts.channel}' failed to launch (${String(err).slice(0, 200)}); falling back to bundled Chromium`,
        );
      }
    }
    this.browser = (await chromium.launch(base)) as PwBrowser;
    return this.browser;
  }

  private key(platform: PlatformId, pincode: string): string {
    return `${platform}:${pincode}`;
  }

  /** One persistent context per (platform, pincode). Recycled on max age. */
  private async context(platform: PlatformId, pincode: string): Promise<PwContext> {
    const key = this.key(platform, pincode);
    const existing = this.contexts.get(key);
    if (existing && this.opts.now() - existing.createdAt < this.maxAge) {
      return existing.context;
    }
    if (existing) {
      try {
        await existing.context.close();
      } catch {
        /* ignore */
      }
    }
    const browser = await this.ensureBrowser();
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      locale: 'en-IN',
    });
    this.contexts.set(key, { context, createdAt: this.opts.now(), pincode });
    return context;
  }

  async ensureLocation(platform: PlatformId, pincode: string, _useAuth: boolean): Promise<LocationResult> {
    try {
      const context = await this.context(platform, pincode);
      const page = await context.newPage();
      try {
        const applied = await applyLocation(platform, page, pincode, this.opts.navTimeoutMs ?? 30000);
        return applied;
      } finally {
        await page.close();
      }
    } catch (err) {
      return { applied: false, serviceable: false, detail: String(err) };
    }
  }

  async probeSession(platform: PlatformId, pincode: string): Promise<SessionProbe> {
    try {
      const context = await this.context(platform, pincode);
      const cookies = await context.cookies();
      const loggedIn = cookies.some((c: any) => /at-acbin|sess-|accessToken|auth_key/i.test(c.name));
      return { loggedIn, locationApplied: true, healthy: true };
    } catch (err) {
      return { loggedIn: false, locationApplied: false, healthy: false, detail: String(err) };
    }
  }

  async loadProduct(platform: PlatformId, resolved: ResolvedTarget, pincode: string): Promise<RawContent> {
    const context = await this.context(platform, pincode);
    const page = await context.newPage();
    try {
      return await loadProductContent(platform, page, resolved, pincode, this.opts.navTimeoutMs ?? 30000);
    } catch (err) {
      return { kind: platform === 'amazon' || platform === 'flipkart' || platform === 'bigbasket' ? 'html' : 'json', finalUrl: resolved.url ?? '', html: '', blocked: true, httpStatus: 0 };
    } finally {
      await page.close();
    }
  }

  async search(platform: PlatformId, query: string, pincode: string): Promise<RawContent> {
    const context = await this.context(platform, pincode);
    const page = await context.newPage();
    try {
      return await runSearch(platform, page, query, this.opts.navTimeoutMs ?? 30000);
    } catch (err) {
      return { kind: 'html', finalUrl: '', html: '', blocked: true };
    } finally {
      await page.close();
    }
  }

  async close(): Promise<void> {
    for (const { context } of this.contexts.values()) {
      try {
        await context.close();
      } catch {
        /* ignore */
      }
    }
    this.contexts.clear();
    if (this.browser) await this.browser.close();
    this.browser = null;
  }
}

// ---------------------------------------------------------------------------
// Per-platform browser flows. These are the fragile, maintenance-prone parts;
// the pure verdict logic lives in ../<platform>/signals.ts.
// ---------------------------------------------------------------------------

const BLOCK_MARKERS = ['captcha', 'robot check', 'to discuss automated access', 'access denied'];

function looksBlocked(html: string, status: number): boolean {
  if (status === 403 || status === 429 || status === 503) return true;
  const lower = html.slice(0, 4000).toLowerCase();
  return BLOCK_MARKERS.some((m) => lower.includes(m));
}

async function applyLocation(platform: PlatformId, page: PwPage, pincode: string, timeout: number): Promise<LocationResult> {
  switch (platform) {
    case 'amazon': {
      await page.goto('https://www.amazon.in/', { waitUntil: 'domcontentloaded', timeout });
      // GLOW pincode entry (best-effort; layout varies).
      try {
        await page.click('#nav-global-location-popover-link', { timeout: 5000 });
        await page.fill('#GLUXZipUpdateInput', pincode);
        await page.click('#GLUXZipUpdate input, #GLUXZipUpdate');
        await page.waitForTimeout(1500);
      } catch {
        /* location UI not present; guest default applies */
      }
      return { applied: true, serviceable: true };
    }
    case 'flipkart': {
      // Location is applied on the product page widget at check time.
      return { applied: true, serviceable: true };
    }
    case 'blinkit':
    case 'zepto':
    case 'instamart':
    case 'bigbasket': {
      // Quick-commerce: location is captured through the site's own flow. For a
      // robust monitor the user sets it once via the login/location window; here
      // we simply mark applied and rely on the per-context cookie jar.
      return { applied: true, serviceable: true };
    }
    default:
      return { applied: true, serviceable: true };
  }
}

async function loadProductContent(
  platform: PlatformId,
  page: PwPage,
  resolved: ResolvedTarget,
  pincode: string,
  timeout: number,
): Promise<RawContent> {
  const url = resolved.url;
  switch (platform) {
    case 'amazon':
    case 'flipkart':
    case 'bigbasket': {
      if (!url) return { kind: 'html', finalUrl: '', html: '', empty: true };
      let resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
      let status = (resp && typeof resp.status === 'function' ? resp.status() : 200) as number;
      if (platform === 'bigbasket' && status === 403) {
        // Akamai rejects cold contexts; a home-page visit seeds the edge
        // cookies, after which the product page loads. One retry only.
        await page.goto('https://www.bigbasket.com/', { waitUntil: 'domcontentloaded', timeout }).catch(() => undefined);
        await page.waitForTimeout(1500);
        resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
        status = (resp && typeof resp.status === 'function' ? resp.status() : 200) as number;
      }
      if (platform === 'flipkart') {
        // Enter the pincode into the widget so we read location-specific stock.
        try {
          await page.fill('input[title="Enter Delivery Pincode"], input#pincodeInputId', pincode);
          await page.click('span:has-text("Check"), .lW_9G3', { timeout: 3000 });
          await page.waitForTimeout(1200);
        } catch {
          /* widget not present */
        }
      }
      const html = await page.content();
      return {
        kind: 'html',
        html,
        finalUrl: page.url(),
        httpStatus: status,
        blocked: looksBlocked(html, status),
        loginWall: /ap\/signin|\/login/i.test(page.url()),
      };
    }
    case 'zepto': {
      // The product page embeds its availability as schema.org Offer microdata
      // and renders headlessly with no location set (verified live 2026-07).
      // No interceptable availability API exists on page load, so the rendered
      // page IS the truth source; extractZepto reads the structured microdata.
      if (!url) return { kind: 'html', finalUrl: '', html: '', empty: true };
      const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
      const status = (resp && typeof resp.status === 'function' ? resp.status() : 200) as number;
      await page.waitForTimeout(SPA_RENDER_WAIT_MS);
      const html = await page.content();
      return {
        kind: 'html',
        html,
        finalUrl: page.url(),
        httpStatus: status,
        blocked: looksBlocked(html, status),
        empty: html.length < 5000, // SPA shell that never hydrated
      };
    }
    case 'blinkit':
    case 'instamart': {
      // SPA: navigate, then read the internal API JSON the app fetched. We use
      // the page's own fetch so requests carry the genuine context/cookies.
      if (url) await page.goto(url, { waitUntil: 'domcontentloaded', timeout }).catch(() => undefined);
      const endpoint = internalEndpoint(platform, resolved);
      if (!endpoint) {
        // Fall back to reading rendered JSON embedded in the page.
        const html = await page.content();
        return { kind: 'json', json: extractEmbeddedJson(html), finalUrl: page.url() };
      }
      const result = await page.evaluate<{ status: number; text: string }>(async (ep: string) => {
        try {
          const r = await fetch(ep, { credentials: 'include' });
          const text = await r.text();
          return { status: r.status, text };
        } catch (e) {
          return { status: 0, text: '' };
        }
      }, endpoint);
      const empty = !result.text || result.text.length < 20;
      let json: unknown = undefined;
      try {
        json = result.text ? JSON.parse(result.text) : undefined;
      } catch {
        json = undefined;
      }
      return {
        kind: 'json',
        json,
        finalUrl: page.url(),
        httpStatus: result.status,
        blocked: result.status === 403 || result.status === 429,
        empty: empty || (result.status === 200 && json === undefined),
      };
    }
    default:
      return { kind: 'html', finalUrl: url ?? '', html: '', empty: true };
  }
}

function internalEndpoint(platform: PlatformId, resolved: ResolvedTarget): string | undefined {
  switch (platform) {
    case 'blinkit':
      return resolved.keyword
        ? `https://blinkit.com/v6/search/products?q=${encodeURIComponent(resolved.keyword)}&search_type=6`
        : undefined;
    case 'instamart':
      return undefined; // needs a storeId resolved from the session; no static endpoint
    default:
      return undefined;
  }
}

function extractEmbeddedJson(html: string): unknown {
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (m) {
    try {
      return JSON.parse(m[1]!);
    } catch {
      /* ignore */
    }
  }
  return undefined;
}

async function runSearch(platform: PlatformId, page: PwPage, query: string, timeout: number): Promise<RawContent> {
  switch (platform) {
    case 'amazon':
    case 'flipkart': {
      const resp = await page.goto(platformSearchUrl(platform, query), { waitUntil: 'domcontentloaded', timeout });
      const status = (resp && typeof resp.status === 'function' ? resp.status() : 200) as number;
      const html = await page.content();
      return { kind: 'html', html, finalUrl: page.url(), httpStatus: status, blocked: looksBlocked(html, status) };
    }
    case 'bigbasket': {
      // Akamai rejects cold clients; visiting the home page first seeds the
      // edge cookies for this context, then the search page can load.
      await page.goto('https://www.bigbasket.com/', { waitUntil: 'domcontentloaded', timeout }).catch(() => undefined);
      await page.waitForTimeout(1500);
      const resp = await page.goto(platformSearchUrl(platform, query), { waitUntil: 'domcontentloaded', timeout });
      const status = (resp && typeof resp.status === 'function' ? resp.status() : 200) as number;
      await page.waitForTimeout(SPA_RENDER_WAIT_MS);
      const html = await page.content();
      return { kind: 'html', html, finalUrl: page.url(), httpStatus: status, blocked: looksBlocked(html, status) };
    }
    case 'instamart':
      // Swiggy's WAF serves stubs to headless clients and search needs a
      // located store session; skip the wasted page load. The adapter reports
      // no candidates and the target stays keyword-monitored.
      return { kind: 'json', json: undefined, finalUrl: '', empty: true };
    default: {
      // Quick-commerce SPAs (zepto/blinkit): navigate to the real search
      // page, let it render, and return the rendered HTML — the adapters
      // parse the product-card anchors, whose hrefs are canonical product
      // URLs. (Previously this branch read a blank page and every keyword
      // search returned nothing.)
      const resp = await page.goto(platformSearchUrl(platform, query), { waitUntil: 'domcontentloaded', timeout });
      const status = (resp && typeof resp.status === 'function' ? resp.status() : 200) as number;
      await page.waitForTimeout(SPA_RENDER_WAIT_MS);
      const html = await page.content();
      return { kind: 'html', html, finalUrl: page.url(), httpStatus: status, blocked: looksBlocked(html, status) };
    }
  }
}
