import { Pedestrian } from '../agents/pedestrian';

/**
 * Anything that can watch pedestrians and emit attention events.
 * The ground-truth implementation reads simulation state directly; a future
 * CV implementation would consume rendered frames from StorefrontCamera instead.
 */
export interface AttentionDetector {
  /** Advance by dt seconds at simulation time t. */
  update(t: number, dt: number, peds: readonly Pedestrian[]): void;
  /** Called by the crowd when a pedestrian leaves the simulation (walked off or entered). */
  onPedestrianRemoved(t: number, p: Pedestrian): void;
  isLooking(pedId: number): boolean;
  readonly lookingCount: number;
  reset(): void;
}
