/** Присутствие: ручная машина фаз и управляемый жизненный цикл исполнителей. */
export { createPresence, swapPresence } from './machine.js';
export type {
  PresenceState, PresenceSnapshot, PresencePhaseStart, PresenceOptions,
  PresenceControls, SwapPresenceOptions,
} from './machine.js';
export { createPresenceTransition } from './transition.js';
export type {
  PresenceAnimation, PresenceTransitionOptions, PresenceTransitionControls,
  PresenceTransitionResult,
} from './transition.js';
