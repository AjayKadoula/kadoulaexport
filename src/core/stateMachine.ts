/**
 * The availability state machine.
 *
 * Given a target's current machine state and a new Observation, it decides:
 *   - what the target's state becomes,
 *   - whether a transition occurred,
 *   - whether that transition is alert-worthy,
 *   - and whether an AVAILABLE reading still needs a confirmation re-check.
 *
 * This is the single place where "a false AVAILABLE alert is unacceptable" is
 * enforced (hysteresis into AVAILABLE, flap damping, ERROR/UNKNOWN overlays).
 * It is pure and deterministic.
 */

import {
  AvailabilityState,
  Money,
  Observation,
  Target,
  TransitionReason,
  isCommercialState,
  RESTOCK_FROM_STATES,
} from './types';

export interface StateMachineConfig {
  /** Confidence at/above which a fresh AVAILABLE needs no second observation. */
  readonly directAlertConfidence: number;
  /** Consecutive ERRORs before a target is marked degraded + user notified. */
  readonly errorStreakToDegrade: number;
  /** Price delta (minor units) needed to raise a price-change alert. */
  readonly priceChangeThresholdMinor: number;
  /** Flaps within the window that trip volatile-stock damping. */
  readonly flapThreshold: number;
  readonly flapWindowMs: number;
  /** Cooldown after volatile-stock damping trips. */
  readonly volatileCooldownMs: number;
}

export const DEFAULT_SM_CONFIG: StateMachineConfig = {
  directAlertConfidence: 0.9,
  errorStreakToDegrade: 3,
  priceChangeThresholdMinor: 100_00, // ₹100
  flapThreshold: 4,
  flapWindowMs: 60 * 60 * 1000,
  volatileCooldownMs: 30 * 60 * 1000,
};

export interface StepResult {
  /** True if the target's persisted state changed as a result of this step. */
  changed: boolean;
  transition?: {
    from: AvailabilityState;
    to: AvailabilityState;
    reason: TransitionReason;
    alertWorthy: boolean;
  };
  /** Engine should schedule a confirmation re-check for this target. */
  needsConfirmation: boolean;
  /** Engine should emit a one-time "target degraded" user notification. */
  raiseDegraded: boolean;
  /** Engine should emit a one-time "target recovered" notice after degrade. */
  clearedDegraded: boolean;
}

function reasonFor(from: AvailabilityState, to: AvailabilityState): TransitionReason {
  if (to === AvailabilityState.AVAILABLE) {
    if (from === AvailabilityState.COMING_SOON || from === AvailabilityState.PREORDER) {
      return 'launch';
    }
    if (from === AvailabilityState.UNAVAILABLE_IN_AREA) return 'area-serviceable';
    if (from === AvailabilityState.NOT_LISTED) return 'listing-appeared';
    return 'restock';
  }
  if (to === AvailabilityState.PREORDER) return 'preorder-open';
  if (to === AvailabilityState.COMING_SOON) return 'listing-appeared';
  if (to === AvailabilityState.OUT_OF_STOCK) return 'stock-lost';
  if (to === AvailabilityState.TEMPORARILY_UNAVAILABLE) return 'went-temporarily-unavailable';
  return 'info';
}

/** Transitions that are alert-worthy: the user is told good news is possible. */
function isAlertWorthy(from: AvailabilityState, to: AvailabilityState): boolean {
  if (to === AvailabilityState.AVAILABLE && RESTOCK_FROM_STATES.has(from)) return true;
  if (to === AvailabilityState.PREORDER && from !== AvailabilityState.AVAILABLE) return true;
  if (
    to === AvailabilityState.COMING_SOON &&
    (from === AvailabilityState.NOT_LISTED || from === AvailabilityState.UNKNOWN)
  ) {
    return true;
  }
  return false;
}

/**
 * Advance the state machine. Mutates `t` (the target's machine fields) and
 * returns what the engine should do about it.
 */
export function step(
  t: Target,
  obs: Observation,
  cfg: StateMachineConfig = DEFAULT_SM_CONFIG,
): StepResult {
  t.lastCheckedAt = obs.at;
  // Capture the price we are comparing against BEFORE overwriting lastPrice.
  const priorPrice = t.lastPrice;
  if (obs.price) t.lastPrice = obs.price;

  const result: StepResult = {
    changed: false,
    needsConfirmation: false,
    raiseDegraded: false,
    clearedDegraded: false,
  };

  // --- ERROR overlay: never touches commercial state -----------------------
  if (obs.state === AvailabilityState.ERROR) {
    t.consecutiveErrors += 1;
    if (t.consecutiveErrors === cfg.errorStreakToDegrade && t.health !== 'degraded') {
      t.health = 'degraded';
      result.raiseDegraded = true;
    }
    // Do NOT change t.state / lastCommercialState. Pending confirmations are
    // preserved: a transient error mid-confirmation shouldn't lose progress.
    return result;
  }

  // Any non-error observation clears an active error streak / degraded health.
  if (t.consecutiveErrors > 0 || t.health === 'degraded' || t.health === 'offline') {
    if (t.health === 'degraded') result.clearedDegraded = true;
    t.consecutiveErrors = 0;
    if (t.health === 'degraded' || t.health === 'offline') t.health = 'ok';
  }

  // --- UNKNOWN overlay: record, preserve last commercial state -------------
  if (obs.state === AvailabilityState.UNKNOWN) {
    // A single UNKNOWN doesn't change the world; but if we were mid-confirming
    // an AVAILABLE, the contradiction resets the confirmation (no alert).
    if (t.pendingAvailableConfirms > 0) {
      t.pendingAvailableConfirms = 0;
    }
    if (t.state !== AvailabilityState.UNKNOWN) {
      // Reflect uncertainty in the live state but keep lastCommercialState.
      t.state = AvailabilityState.UNKNOWN;
    }
    if (t.health === 'ok') t.health = 'unstable';
    return result;
  }

  // From here, obs.state is a commercial state.
  const from = t.lastCommercialState;

  // --- Hysteresis into AVAILABLE ------------------------------------------
  if (obs.state === AvailabilityState.AVAILABLE && from !== AvailabilityState.AVAILABLE) {
    const strong = obs.confidence >= cfg.directAlertConfidence && !obs.confirming;
    const confirmedByRecheck = obs.confirming === true; // this obs IS the confirmation
    if (!strong && !confirmedByRecheck) {
      // First AVAILABLE sighting that isn't strong enough: require confirmation.
      t.pendingAvailableConfirms = 1;
      t.state = AvailabilityState.UNKNOWN; // shown as "checking" — not yet AVAILABLE
      result.needsConfirmation = true;
      return result;
    }
    // strong (high-confidence direct) OR this is the confirming re-check:
    return commitTransition(t, obs, from, cfg, result);
  }

  // --- Commercial state that is not a fresh AVAILABLE ----------------------
  if (obs.state === AvailabilityState.AVAILABLE && from === AvailabilityState.AVAILABLE) {
    // Still available: maybe a price-change alert.
    t.state = AvailabilityState.AVAILABLE;
    t.lastCommercialState = AvailabilityState.AVAILABLE;
    t.pendingAvailableConfirms = 0;
    if (t.health === 'unstable') t.health = 'ok';
    return maybePriceChange(t, obs, priorPrice, cfg, result);
  }

  // Non-available commercial observation.
  t.pendingAvailableConfirms = 0;
  return commitTransition(t, obs, from, cfg, result);
}

function commitTransition(
  t: Target,
  obs: Observation,
  from: AvailabilityState,
  cfg: StateMachineConfig,
  result: StepResult,
): StepResult {
  const to = obs.state;
  t.state = to;
  const prevCommercial = t.lastCommercialState;
  if (isCommercialState(to)) t.lastCommercialState = to;

  if (to === from) {
    // No change in commercial state (e.g. OOS -> OOS). Update health only.
    if (t.health === 'unstable') t.health = 'ok';
    return result;
  }

  // Flap damping: count AVAILABLE<->non-AVAILABLE oscillations.
  const isFlapEdge =
    (to === AvailabilityState.AVAILABLE && prevCommercial !== AvailabilityState.AVAILABLE) ||
    (prevCommercial === AvailabilityState.AVAILABLE && to !== AvailabilityState.AVAILABLE);
  if (isFlapEdge) {
    if (obs.at - t.flapWindowStart > cfg.flapWindowMs) {
      t.flapWindowStart = obs.at;
      t.flapCount = 0;
    }
    t.flapCount += 1;
  }

  const reason = reasonFor(from, to);
  let alertWorthy = isAlertWorthy(from, to);

  // Volatile-stock damping: too many flaps -> collapse into cooldown.
  if (alertWorthy && to === AvailabilityState.AVAILABLE) {
    if (obs.at < t.volatileCooldownUntil) {
      alertWorthy = false; // inside cooldown, suppress
    } else if (t.flapCount >= cfg.flapThreshold) {
      // Trip the cooldown; this alert becomes a single "volatile stock" notice.
      t.volatileCooldownUntil = obs.at + cfg.volatileCooldownMs;
      result.changed = true;
      result.transition = { from, to, reason: 'volatile-stock', alertWorthy: true };
      t.lastConfirmedAt = obs.at;
      t.stateSince = obs.at;
      t.health = 'ok';
      return result;
    }
  }

  t.stateSince = obs.at;
  if (to === AvailabilityState.AVAILABLE) {
    t.lastConfirmedAt = obs.at;
    t.priceAtLastAlert = obs.price;
  }
  if (t.health === 'unstable') t.health = 'ok';

  result.changed = true;
  result.transition = { from, to, reason, alertWorthy };
  return result;
}

/**
 * While a target stays AVAILABLE, raise a price-change alert when the price
 * moves by at least the configured threshold from the price at the last
 * alert/transition. Compares against `priceAtLastAlert` (stable basis), not the
 * previous observation, so many small drifts don't each fire.
 */
function maybePriceChange(
  t: Target,
  obs: Observation,
  _priorPrice: Money | undefined,
  cfg: StateMachineConfig,
  result: StepResult,
): StepResult {
  if (!obs.price) return result;
  const basis = t.priceAtLastAlert;
  if (!basis || basis.currency !== obs.price.currency) {
    t.priceAtLastAlert = obs.price;
    return result;
  }
  const delta = Math.abs(obs.price.minor - basis.minor);
  if (delta >= cfg.priceChangeThresholdMinor) {
    t.priceAtLastAlert = obs.price;
    t.stateSince = obs.at; // a price-change is a meaningful event marker
    result.changed = true;
    result.transition = {
      from: AvailabilityState.AVAILABLE,
      to: AvailabilityState.AVAILABLE,
      reason: 'price-change',
      alertWorthy: true,
    };
  }
  return result;
}
