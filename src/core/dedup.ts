/**
 * Duplicate-alert prevention. An alert-worthy transition is only dispatched
 * once per "edge": the tuple (targetId, reason, stateEnteredAt). Because the
 * engine records dispatch in the same persistence transaction that commits the
 * transition, a restart cannot re-fire an already-dispatched edge.
 *
 * The ledger is an in-memory reflection of persisted keys; the engine loads
 * recent keys on startup so cross-restart dedup holds.
 */

import { AvailabilityState, TransitionReason } from './types';

export interface EdgeKeyParts {
  targetId: string;
  reason: TransitionReason;
  toState: AvailabilityState;
  /** stateSince / event timestamp — makes re-entry after a real change distinct. */
  stateEnteredAt: number;
}

export function edgeKey(p: EdgeKeyParts): string {
  return `${p.targetId}|${p.reason}|${p.toState}|${p.stateEnteredAt}`;
}

export class DedupLedger {
  private readonly seen = new Set<string>();

  constructor(seedKeys: Iterable<string> = []) {
    for (const k of seedKeys) this.seen.add(k);
  }

  /** True if this edge has not been alerted before (and records it). */
  claim(parts: EdgeKeyParts): boolean {
    const key = edgeKey(parts);
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    return true;
  }

  has(parts: EdgeKeyParts): boolean {
    return this.seen.has(edgeKey(parts));
  }

  get size(): number {
    return this.seen.size;
  }
}
