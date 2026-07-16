/**
 * Canonical, user-openable search-page URLs per platform. Used by the
 * Playwright runtime to run keyword searches, by the simulated runtime so demo
 * links open something real, and by the web UI as the link of last resort for
 * a target that has not resolved to a product page yet. Every URL here opens
 * in a normal browser without any session state.
 */

import { PlatformId } from '../core/types';

export function platformSearchUrl(platform: PlatformId, query: string): string {
  const q = encodeURIComponent(query);
  switch (platform) {
    case 'amazon':
      return `https://www.amazon.in/s?k=${q}`;
    case 'flipkart':
      return `https://www.flipkart.com/search?q=${q}`;
    case 'blinkit':
      return `https://blinkit.com/s/?q=${q}`;
    case 'zepto':
      return `https://www.zepto.com/search?query=${q}`;
    case 'instamart':
      return `https://www.swiggy.com/instamart/search?query=${q}`;
    case 'bigbasket':
      return `https://www.bigbasket.com/ps/?q=${q}`;
  }
}
