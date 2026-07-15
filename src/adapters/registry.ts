/**
 * Adapter registry. The engine is handed a Map<PlatformId, PlatformAdapter>;
 * this builds it from a single AdapterRuntime. Adding platform #7 means adding
 * one line here (and its adapter module) — the engine never changes.
 */

import { PlatformAdapter, PlatformId, PlatformManifest } from '../core/types';
import { AdapterRuntime } from './runtime';
import { AmazonAdapter, AMAZON_MANIFEST } from './amazon/adapter';
import { FlipkartAdapter, FLIPKART_MANIFEST } from './flipkart/adapter';
import { BlinkitAdapter, BLINKIT_MANIFEST } from './blinkit/adapter';
import { ZeptoAdapter, ZEPTO_MANIFEST } from './zepto/adapter';
import { InstamartAdapter, INSTAMART_MANIFEST } from './instamart/adapter';
import { BigBasketAdapter, BIGBASKET_MANIFEST } from './bigbasket/adapter';

export const MANIFESTS: Record<PlatformId, PlatformManifest> = {
  amazon: AMAZON_MANIFEST,
  flipkart: FLIPKART_MANIFEST,
  blinkit: BLINKIT_MANIFEST,
  zepto: ZEPTO_MANIFEST,
  instamart: INSTAMART_MANIFEST,
  bigbasket: BIGBASKET_MANIFEST,
};

export function buildAdapters(runtime: AdapterRuntime): Map<PlatformId, PlatformAdapter> {
  return new Map<PlatformId, PlatformAdapter>([
    ['amazon', new AmazonAdapter(runtime)],
    ['flipkart', new FlipkartAdapter(runtime)],
    ['blinkit', new BlinkitAdapter(runtime)],
    ['zepto', new ZeptoAdapter(runtime)],
    ['instamart', new InstamartAdapter(runtime)],
    ['bigbasket', new BigBasketAdapter(runtime)],
  ]);
}

export const ALL_PLATFORM_IDS: PlatformId[] = [
  'amazon',
  'flipkart',
  'blinkit',
  'zepto',
  'instamart',
  'bigbasket',
];
