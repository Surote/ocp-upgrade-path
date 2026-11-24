import type { Version } from '../graph/types';
import type { ChannelSegment } from './lookahead';
import type { Path } from './types';

/**
 * How the route search ranks candidate routes once support posture (anchor
 * class first, plan.md §6) is equal. `recommended` keeps the existing order
 * (hops, then risk). `avoidConditional` ranks `Always` risk occurrences,
 * then conditional risk occurrences, before hops. Neither policy widens
 * channel eligibility: avoiding a risk never moves a cluster onto a
 * fallback class the recommended route would not use.
 */
export type RiskPolicy = 'recommended' | 'avoidConditional';

/**
 * Operator-pinned constraints on one route search. `stops` are versions the
 * route must pass through, in order, strictly between start and target.
 */
export interface RouteConstraints {
  readonly stops: readonly Version[];
  readonly riskPolicy: RiskPolicy;
}

export const NO_CONSTRAINTS: RouteConstraints = { stops: [], riskPolicy: 'recommended' };

/**
 * The lower-risk counterpart to the recommended route, computed with
 * `avoidConditional` under the same stops. `route` is undefined when no
 * route with fewer risk occurrences exists. `conditionalFree` is true when
 * `route` (or the recommended route itself, if it is already the lowest)
 * carries no conditional risk on any hop.
 */
export interface RiskComparison {
  readonly route: Path | undefined;
  readonly conditionalFree: boolean;
}

/** One selectable version for the stop being edited. */
export interface StopOption {
  readonly version: Version;
  /** The channel whose graph supplies this version on a route that honors every other stop. */
  readonly channel: string;
}

/**
 * Versions the operator may pin at stop index `gap` (0 = between start and
 * the first stop), given every other stop: each offered version is reachable
 * from start through the stops before it and can still reach target through
 * the stops after it, on the same segments the route search uses. Newest
 * first. Contract stub; the engine track implements it.
 */
export function buildStopOptions(
  _segments: readonly ChannelSegment[],
  _start: Version,
  _target: Version,
  _stops: readonly Version[],
  _gap: number,
): readonly StopOption[] {
  return [];
}
