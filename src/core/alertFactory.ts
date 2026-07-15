/**
 * Build user-facing Alert objects from transitions. Pure.
 */

import {
  Alert,
  ConfidenceLevel,
  Observation,
  Product,
  Target,
  Transition,
  TransitionReason,
  AvailabilityState,
} from './types';

export function confidenceLevel(confidence: number): ConfidenceLevel {
  if (confidence >= 0.9) return 'high';
  if (confidence >= 0.7) return 'medium';
  return 'low';
}

export function buildAlert(params: {
  id: string;
  transition: Transition;
  target: Target;
  product: Product;
}): Alert {
  const { transition, target, product } = params;
  const obs = transition.observation;
  return {
    id: params.id,
    transitionId: transition.id,
    targetId: target.id,
    at: transition.at,
    productName: product.name,
    platformId: target.platformId,
    pincode: target.pincode,
    state: transition.to,
    reason: transition.reason,
    price: obs.price ?? target.lastPrice,
    url: obs.url ?? product.urls?.[target.platformId],
    confidence: obs.confidence,
    confidenceLevel: confidenceLevel(obs.confidence),
  };
}

export function makeTransition(params: {
  id: string;
  targetId: string;
  from: AvailabilityState;
  to: AvailabilityState;
  reason: TransitionReason;
  alertWorthy: boolean;
  observation: Observation;
}): Transition {
  return { ...params, at: params.observation.at };
}
