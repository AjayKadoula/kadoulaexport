/**
 * Target construction and default machine state.
 */

import { AvailabilityState, PlatformId, Target } from './types';

export function newTarget(params: {
  id: string;
  productId: string;
  platformId: PlatformId;
  pincode: string;
  intervalS: number;
  now: number;
  enabled?: boolean;
}): Target {
  return {
    id: params.id,
    productId: params.productId,
    platformId: params.platformId,
    pincode: params.pincode,
    enabled: params.enabled ?? true,
    intervalS: params.intervalS,
    nextDueAt: params.now,
    backoffLevel: 0,
    state: AvailabilityState.UNKNOWN,
    lastCommercialState: AvailabilityState.UNKNOWN,
    stateSince: params.now,
    lastConfirmedAt: 0,
    lastCheckedAt: 0,
    consecutiveErrors: 0,
    pendingAvailableConfirms: 0,
    flapCount: 0,
    flapWindowStart: params.now,
    volatileCooldownUntil: 0,
    health: 'ok',
  };
}
