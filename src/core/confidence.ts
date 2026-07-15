/**
 * Confidence model: turn a set of extracted signals into a 9-state verdict with
 * a confidence score. This is where "never guess" lives — incoherent or empty
 * evidence yields UNKNOWN, never a commercial state.
 *
 * The function is deterministic and pure so it can be unit-tested exhaustively
 * against adapter fixtures.
 */

import { AvailabilityState, Observation, Signal, SignalKind, Money, FetchVia } from './types';

/** Signal weights toward "available" (+) or "not available" (−) truth. */
const AVAILABILITY_WEIGHT: Partial<Record<SignalKind, number>> = {
  [SignalKind.API_IN_STOCK]: 1.0,
  [SignalKind.API_OUT_OF_STOCK]: -1.0,
  [SignalKind.STRUCTURED_IN_STOCK]: 0.9,
  [SignalKind.STRUCTURED_OUT_OF_STOCK]: -0.9,
  [SignalKind.BUY_CONTROL_PRESENT]: 0.8,
  [SignalKind.BUY_CONTROL_ABSENT]: -0.6,
  [SignalKind.TEXT_AVAILABLE]: 0.4,
  [SignalKind.TEXT_OUT_OF_STOCK]: -0.7,
};

export interface Verdict {
  state: AvailabilityState;
  confidence: number;
}

function has(signals: readonly Signal[], kind: SignalKind): boolean {
  return signals.some((s) => s.kind === kind);
}

/**
 * Decide the verdict. Order matters: hard "not commercial" and "ambiguous"
 * classifications are resolved before we weigh in-stock vs out-of-stock.
 */
export function decideVerdict(signals: readonly Signal[]): Verdict {
  // 1. Block / empty / ambiguous signatures dominate everything: we cannot
  //    trust any availability reading, so it is UNKNOWN (never OOS, never OK).
  if (has(signals, SignalKind.BLOCK_SIGNATURE) || has(signals, SignalKind.AMBIGUOUS_EMPTY)) {
    return { state: AvailabilityState.UNKNOWN, confidence: 0.0 };
  }
  if (has(signals, SignalKind.LOGIN_WALL)) {
    // Auth wall: the engine/session-manager handles this; not a commercial state.
    return { state: AvailabilityState.UNKNOWN, confidence: 0.0 };
  }

  // 2. Distinct non-stock states with explicit markers.
  if (has(signals, SignalKind.TEXT_AREA_UNAVAILABLE)) {
    return { state: AvailabilityState.UNAVAILABLE_IN_AREA, confidence: 0.9 };
  }
  if (has(signals, SignalKind.NOT_FOUND_IN_CATALOG)) {
    return { state: AvailabilityState.NOT_LISTED, confidence: 0.85 };
  }
  if (has(signals, SignalKind.TEXT_COMING_SOON)) {
    return { state: AvailabilityState.COMING_SOON, confidence: 0.8 };
  }
  if (has(signals, SignalKind.TEXT_PREORDER)) {
    return { state: AvailabilityState.PREORDER, confidence: 0.8 };
  }
  if (has(signals, SignalKind.TEXT_TEMPORARILY_UNAVAILABLE)) {
    return { state: AvailabilityState.TEMPORARILY_UNAVAILABLE, confidence: 0.85 };
  }

  // 3. Weigh available vs out-of-stock from the remaining signals.
  let score = 0;
  let magnitude = 0;
  let positives = 0;
  let negatives = 0;
  for (const s of signals) {
    const w = AVAILABILITY_WEIGHT[s.kind];
    if (w === undefined) continue;
    score += w;
    magnitude += Math.abs(w);
    if (w > 0) positives++;
    if (w < 0) negatives++;
  }

  if (magnitude === 0) {
    // No availability-bearing signals at all — we truly don't know.
    return { state: AvailabilityState.UNKNOWN, confidence: 0.0 };
  }

  // Disagreement: strong signals point both ways -> cap confidence, prefer the
  // safe reading. A conflicting page is UNKNOWN unless one side clearly wins.
  const agreement = Math.abs(score) / magnitude; // 0 (conflict) .. 1 (aligned)
  if (positives > 0 && negatives > 0 && agreement < 0.34) {
    return { state: AvailabilityState.UNKNOWN, confidence: 0.5 * agreement };
  }

  if (score > 0) {
    // Confidence scales with agreement and the strength of the winning signals.
    const confidence = clamp(0.5 + 0.5 * agreement * strength(score), 0, 0.99);
    return { state: AvailabilityState.AVAILABLE, confidence };
  }
  const confidence = clamp(0.5 + 0.5 * agreement * strength(-score), 0, 0.99);
  return { state: AvailabilityState.OUT_OF_STOCK, confidence };
}

function strength(absScore: number): number {
  // A single strong signal (weight ~1) already gives near-full strength.
  return clamp(absScore, 0, 1);
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

/** Assemble a complete Observation from extracted evidence. */
export function buildObservation(params: {
  signals: readonly Signal[];
  price?: Money;
  url?: string;
  fetchedVia: FetchVia;
  at: number;
  confirming?: boolean;
  /** Adapters may override the verdict when they have a definitive API truth. */
  overrideState?: AvailabilityState;
  overrideConfidence?: number;
}): Observation {
  const verdict =
    params.overrideState !== undefined
      ? { state: params.overrideState, confidence: params.overrideConfidence ?? 0.95 }
      : decideVerdict(params.signals);
  return {
    state: verdict.state,
    confidence: verdict.confidence,
    signals: params.signals,
    price: params.price,
    url: params.url,
    fetchedVia: params.fetchedVia,
    at: params.at,
    confirming: params.confirming,
  };
}

/** An observation representing a failed check (network/timeout/crash). */
export function errorObservation(params: {
  detail: string;
  url?: string;
  fetchedVia: FetchVia;
  at: number;
  confirming?: boolean;
}): Observation {
  return {
    state: AvailabilityState.ERROR,
    confidence: 0,
    signals: [{ kind: SignalKind.BLOCK_SIGNATURE, source: 'fetch', detail: params.detail }],
    url: params.url,
    fetchedVia: params.fetchedVia,
    at: params.at,
    confirming: params.confirming,
  };
}
