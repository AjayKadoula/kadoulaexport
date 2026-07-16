/**
 * Minimal HTML helpers for the DOM-based adapters (Amazon, Flipkart). We avoid a
 * heavy DOM dependency: detection relies on stable id/text markers identified in
 * discovery, which is more robust than obfuscated CSS classes anyway.
 */

export function stripTags(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function hasElementId(html: string, id: string): boolean {
  const re = new RegExp(`id=["']${escapeRe(id)}["']`, 'i');
  return re.test(html);
}

/** Extract the text content of the element with the given id (best-effort). */
export function elementText(html: string, id: string): string | undefined {
  const re = new RegExp(`id=["']${escapeRe(id)}["'][^>]*>([\\s\\S]*?)</`, 'i');
  const m = html.match(re);
  return m ? stripTags(m[1]!) : undefined;
}

export function containsPhrase(text: string, phrase: string): boolean {
  return text.toLowerCase().includes(phrase.toLowerCase());
}

/** Parse all schema.org JSON-LD blocks and return their objects. */
export function parseJsonLd(html: string): unknown[] {
  const out: unknown[] = [];
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    try {
      out.push(JSON.parse(m[1]!));
    } catch {
      /* ignore malformed block */
    }
  }
  return out;
}

/** Find an Offer.availability value (schema.org URL) anywhere in JSON-LD. */
export function jsonLdAvailability(html: string): string | undefined {
  const blocks = parseJsonLd(html);
  let found: string | undefined;
  const walk = (v: unknown): void => {
    if (found || v == null || typeof v !== 'object') return;
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (k.toLowerCase() === 'availability' && typeof val === 'string') {
        found = val;
        return;
      }
      walk(val);
    }
  };
  for (const b of blocks) walk(b);
  return found;
}

/**
 * Decode the HTML entities that appear inside attribute values we scrape
 * (hrefs and titles). Attribute values captured from raw HTML carry `&amp;`
 * etc.; a URL used as a link must carry the literal characters.
 */
export function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/**
 * All <a href> elements with their (bounded) inner HTML. Used by adapters that
 * parse rendered SPA search results, where each product card is an anchor
 * whose href is the canonical product URL. Hrefs are entity-decoded.
 */
export function anchorsWithInner(html: string): Array<{ href: string; inner: string }> {
  const out: Array<{ href: string; inner: string }> = [];
  const re = /<a\b[^>]*?href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null && out.length < 5000) {
    out.push({ href: decodeEntities(m[1]!), inner: m[2]! });
  }
  return out;
}

/** Title of a product card: prefer the product image's alt, else inner text. */
export function anchorTitle(inner: string): string {
  const alt = /alt=["']([^"']{3,})["']/.exec(inner);
  if (alt) return decodeEntities(alt[1]!).trim();
  return stripTags(inner).slice(0, 120).trim();
}

/**
 * True when a candidate title plausibly matches the search query: a strict
 * majority of the query's tokens (length ≥ 2) appear in the title. Guards
 * against harvesting recommendation-rail / sponsored / trending items that
 * rendered search pages mix in — especially on zero-result pages, where
 * resolving a foreign product would make the app report availability for
 * something the user never asked to watch.
 */
export function titleMatchesQuery(title: string, query: string): boolean {
  const tokens = query.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 2);
  if (tokens.length === 0) return true;
  const hay = title.toLowerCase();
  const hits = tokens.filter((t) => hay.includes(t)).length;
  return hits * 2 > tokens.length;
}

/** First rupee amount in a card's text, in minor units (paise). */
export function firstRupeeMinor(inner: string): number | undefined {
  const m = /₹\s?([\d,]+(?:\.\d+)?)/.exec(stripTags(inner));
  if (!m) return undefined;
  const n = parseFloat(m[1]!.replace(/,/g, ''));
  return Number.isFinite(n) ? Math.round(n * 100) : undefined;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
