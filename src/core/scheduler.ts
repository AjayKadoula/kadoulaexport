/**
 * The scheduler decides which targets are due and in what order, enforcing:
 *   - one in-flight request per platform (serialized queues live in the engine),
 *   - fairness across products/locations (least-recently-checked first),
 *   - location-switch minimisation (drain a platform's due targets grouped by
 *     pincode before switching pincode),
 *   - schedule spreading after wake/restart so nothing stampedes.
 *
 * Pure and deterministic. The engine owns the actual dispatch and I/O.
 */

import { Target, PlatformId } from './types';
import { RandomFn } from './rateLimiter';

export interface DueTarget {
  target: Target;
  overdueMs: number;
}

/** Select due targets for a platform, grouped by pincode, fairest first. */
export function selectDueForPlatform(
  targets: Target[],
  platformId: PlatformId,
  now: number,
): DueTarget[] {
  const due = targets
    .filter((t) => t.enabled && t.platformId === platformId && t.nextDueAt <= now)
    .map((t) => ({ target: t, overdueMs: now - t.nextDueAt }));

  // Group by pincode to minimise location switching; within a pincode, the
  // most-overdue (fairest) first. Order pincodes by their most-overdue member.
  const byPin = new Map<string, DueTarget[]>();
  for (const d of due) {
    const arr = byPin.get(d.target.pincode) ?? [];
    arr.push(d);
    byPin.set(d.target.pincode, arr);
  }
  const pins = [...byPin.entries()].sort((a, b) => {
    const aMax = Math.max(...a[1].map((d) => d.overdueMs));
    const bMax = Math.max(...b[1].map((d) => d.overdueMs));
    return bMax - aMax;
  });
  const ordered: DueTarget[] = [];
  for (const [, group] of pins) {
    group.sort((a, b) => b.overdueMs - a.overdueMs);
    ordered.push(...group);
  }
  return ordered;
}

/**
 * Compute the next due time for a target after a check, with jitter.
 * `intervalS` is the effective interval (may be backed off by the caller).
 */
export function nextDue(now: number, intervalS: number, jitter: number, random: RandomFn): number {
  const delta = jitter > 0 ? (random() * 2 - 1) * jitter : 0;
  const seconds = Math.max(1, intervalS * (1 + delta));
  return now + Math.round(seconds * 1000);
}

/**
 * Spread a set of targets' next-due times across the first interval window so
 * they don't all fire together (used after startup and after coming back
 * online). Assigns each target a phase within [0, intervalS).
 */
export function spreadSchedule(targets: Target[], now: number, random: RandomFn): void {
  // Spread per (platform) so each platform's queue is evenly loaded.
  const byPlatform = new Map<PlatformId, Target[]>();
  for (const t of targets) {
    if (!t.enabled) continue;
    const arr = byPlatform.get(t.platformId) ?? [];
    arr.push(t);
    byPlatform.set(t.platformId, arr);
  }
  for (const [, group] of byPlatform) {
    // Randomise order so the spread isn't correlated with insertion order.
    const shuffled = shuffle(group, random);
    const n = shuffled.length;
    shuffled.forEach((t, i) => {
      const windowS = t.intervalS;
      const phase = n > 0 ? (i / n) * windowS : 0;
      // small extra jitter so identical phases (n==1) still vary a little
      const extra = random() * Math.min(5, windowS * 0.05);
      t.nextDueAt = now + Math.round((phase + extra) * 1000);
    });
  }
}

function shuffle<T>(arr: T[], random: RandomFn): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    const tmp = a[i]!;
    a[i] = a[j]!;
    a[j] = tmp;
  }
  return a;
}
