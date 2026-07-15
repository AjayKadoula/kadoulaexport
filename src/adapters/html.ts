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

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
