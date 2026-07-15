/**
 * Shared adapter helpers: convert a RawContent's transport-level guards
 * (blocked / login wall / empty stub) into signals BEFORE any platform-specific
 * parsing, so every adapter uniformly turns these into UNKNOWN (never a
 * commercial state). This is the structural enforcement of the discovery rule
 * "empty/ambiguous/stub ⇒ UNKNOWN, never OUT_OF_STOCK".
 */

import { Observation, Signal, SignalKind, Money, FetchVia } from '../core/types';
import { buildObservation } from '../core/confidence';
import { RawContent } from './runtime';

export interface ExtractResult {
  signals: Signal[];
  price?: Money;
  /** Optional definitive override (e.g. explicit API boolean). */
  overrideState?: import('../core/types').AvailabilityState;
  overrideConfidence?: number;
}

/**
 * Returns transport-level signals if the content is unusable (blocked/login/
 * empty), else null (meaning: proceed to platform parsing).
 */
export function guardSignals(raw: RawContent): Signal[] | null {
  if (raw.blocked) {
    return [{ kind: SignalKind.BLOCK_SIGNATURE, source: `http ${raw.httpStatus ?? '?'}` }];
  }
  if (raw.loginWall) {
    return [{ kind: SignalKind.LOGIN_WALL, source: raw.finalUrl }];
  }
  if (raw.empty) {
    return [{ kind: SignalKind.AMBIGUOUS_EMPTY, source: 'empty/stub body' }];
  }
  return null;
}

export function fetchViaFor(kind: RawContent['kind'], runtimeHint: FetchVia): FetchVia {
  return runtimeHint ?? (kind === 'json' ? 'browser-api' : 'ssr');
}

export function observationFrom(
  raw: RawContent,
  extract: (raw: RawContent) => ExtractResult,
  at: number,
  fetchedVia: FetchVia,
  confirming?: boolean,
): Observation {
  const guard = guardSignals(raw);
  if (guard) {
    return buildObservation({ signals: guard, url: raw.finalUrl, fetchedVia, at, confirming });
  }
  const res = extract(raw);
  return buildObservation({
    signals: res.signals,
    price: res.price,
    url: raw.finalUrl,
    fetchedVia,
    at,
    confirming,
    overrideState: res.overrideState,
    overrideConfidence: res.overrideConfidence,
  });
}

/** Safely read a nested path from an unknown object. */
export function path(obj: unknown, ...keys: (string | number)[]): unknown {
  let cur: unknown = obj;
  for (const k of keys) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string | number, unknown>)[k];
  }
  return cur;
}

/** Recursively collect objects matching a predicate (for nested API shapes). */
export function collect(obj: unknown, pred: (o: Record<string, unknown>) => boolean): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const seen = new Set<unknown>();
  const walk = (v: unknown): void => {
    if (v == null || typeof v !== 'object' || seen.has(v)) return;
    seen.add(v);
    if (!Array.isArray(v) && pred(v as Record<string, unknown>)) out.push(v as Record<string, unknown>);
    for (const child of Object.values(v as Record<string, unknown>)) walk(child);
  };
  walk(obj);
  return out;
}
