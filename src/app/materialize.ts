/**
 * Target materialisation (pure). Turns the user's configuration
 * (products × enabled platforms × enabled locations, plus active profiles) into
 * the concrete list of monitor targets the engine schedules. Preserves existing
 * targets' machine/schedule state by id so re-materialising after a config
 * change doesn't reset progress or re-alert.
 */

import {
  Location,
  PlatformId,
  PlatformSettings,
  Product,
  Target,
} from '../core/types';
import { newTarget } from '../core/target';
import { MANIFESTS } from '../adapters/registry';

export interface MaterializeInput {
  products: Product[];
  platforms: Record<string, PlatformSettings>;
  locations: Location[];
  now: number;
  /** Existing targets keyed by id, to preserve state across re-materialisation. */
  existing?: Map<string, Target>;
}

export function targetId(productId: string, platformId: PlatformId, pincode: string): string {
  return `${productId}::${platformId}::${pincode}`;
}

function effectiveInterval(platformId: PlatformId, settings: PlatformSettings): number {
  const manifest = MANIFESTS[platformId];
  const requested = settings.intervalOverrideS ?? manifest.defaultIntervalS;
  // Never allow an interval below the manifest's minimum spacing (politeness).
  return Math.max(requested, manifest.minSpacingS);
}

export function materialize(input: MaterializeInput): Target[] {
  const out: Target[] = [];
  const enabledLocations = input.locations.filter((l) => l.enabled);
  const enabledPlatforms = (Object.keys(input.platforms) as PlatformId[]).filter(
    (id) => input.platforms[id]?.enabled,
  );

  for (const product of input.products) {
    if (!product.enabled) continue;
    for (const platformId of enabledPlatforms) {
      // URL-mode products only monitor platforms they have a URL for.
      if (product.mode === 'url' && !product.urls?.[platformId]) continue;
      const settings = input.platforms[platformId]!;
      const interval = effectiveInterval(platformId, settings);
      for (const loc of enabledLocations) {
        const id = targetId(product.id, platformId, loc.pincode);
        const existing = input.existing?.get(id);
        if (existing) {
          // Preserve machine + schedule state; just refresh interval + enabled.
          existing.intervalS = interval;
          existing.enabled = true;
          out.push(existing);
        } else {
          out.push(
            newTarget({
              id,
              productId: product.id,
              platformId,
              pincode: loc.pincode,
              intervalS: interval,
              now: input.now,
            }),
          );
        }
      }
    }
  }
  return out;
}

/** Validate a pincode: 6 digits, first digit 1-9 (Indian PIN format). */
export function isValidPincode(pin: string): boolean {
  return /^[1-9][0-9]{5}$/.test(pin.trim());
}
