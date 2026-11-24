import type { Version } from '../graph/types';
import type { ChannelSegment } from './lookahead';
import type { RiskName } from './risks';
import { buildRoutingModel, forEachEdge, reachBackward, reachForward, type RoutingModel } from './routeSearch';
import type { Path } from './types';
import { compareVersions } from './version';

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
 *
 * `notApplicable` names conditional risks the operator checked against their
 * cluster and found not to match. Their conditional occurrences stop counting
 * toward `Route.conditional`, so the `avoidConditional` ranking and the risk
 * comparison ignore them; an `Always` occurrence of the same name still
 * counts. The recommended ranking reads the published risk weight and never
 * changes with a mark, and every hop still carries every risk.
 */
export interface RouteConstraints {
  readonly stops: readonly Version[];
  readonly riskPolicy: RiskPolicy;
  readonly notApplicable: ReadonlySet<RiskName>;
}

export const NO_CONSTRAINTS: RouteConstraints = { stops: [], riskPolicy: 'recommended', notApplicable: new Set() };

/**
 * The lower-risk counterpart to the recommended route, computed with
 * `avoidConditional` under the same stops. `route` is undefined when no
 * route with fewer risk occurrences exists. `conditionalFree` is true when
 * `route` (or the recommended route itself, if it is already the lowest)
 * carries no conditional risk on any hop, besides those marked not applicable.
 */
export interface RiskComparison {
  readonly route: Path | undefined;
  readonly conditionalFree: boolean;
}

/** One selectable version for the stop being edited. */
export interface StopOption {
  readonly version: Version;
  /**
   * The most conservative channel a route honoring every other stop can
   * arrive at this version on. The route the search plans through it may
   * arrive on another channel, so this is a possible arrival, not the plan's.
   */
  readonly channel: string;
}

/**
 * Versions the operator may pin at position `gap` among `stops` (0 = between
 * start and the first stop; `stops.length` = between the last stop and the
 * target). `stops` holds every other stop, without the one being edited.
 * Each offered version is reachable from start through the stops before it
 * and can still reach target through the stops after it, on the segments and
 * transitions the route search uses, so pinning it always routes. Newest
 * first.
 *
 * `segments` is the anchor followed by its look-ahead, as the planner hands
 * them to `buildTargetOptions`. When the anchor holds the target the
 * stitcher routes on the anchor alone, and so does this.
 *
 * Two unweighted passes, not a search per candidate: forward from start, and
 * backward from target. A route may never return to an earlier stream's
 * channel, so a version counts only when the earliest group a route reaches
 * it in is no later than the latest group a route onward can start in.
 */
export function buildStopOptions(
  segments: readonly ChannelSegment[],
  start: Version,
  target: Version,
  stops: readonly Version[],
  gap: number,
): readonly StopOption[] {
  const anchor = segments[0];
  const routed = anchor && anchor.graph.nodes.some((node) => node.version === target) ? [anchor] : segments;
  const model = buildRoutingModel(routed);
  const before = stops.slice(0, gap);
  const forward = reachForward(model, start, before);
  const backward = reachBackward(model, target, stops.slice(gap));
  const excluded = new Set([start, target, ...stops]);

  const options: StopOption[] = [];
  for (const [version, earliest] of forward) {
    const latest = backward.get(version);
    if (excluded.has(version) || latest === undefined || earliest > latest) continue;
    options.push({ version, channel: arrivingChannel(model, forward, version, latest) });
  }
  return options.sort((a, b) => compareVersions(b.version, a.version) || (a.version < b.version ? 1 : -1));
}

/**
 * The most conservative segment a route can arrive at `version` on, among
 * hops a route past the earlier stops can take and still go on: the anchor's
 * class first, then the least drastic fallback, then the earliest group.
 */
function arrivingChannel(model: RoutingModel, forward: ReadonlyMap<Version, number>, version: Version, latest: number): string {
  let best: { readonly tier: number; readonly segment: number } | undefined;
  for (let group = 0; group <= latest; group += 1) {
    forEachEdge(model, model.groups[group] as readonly number[], 'in', version, ({ from }, segment) => {
      const reachedIn = forward.get(from);
      if (reachedIn === undefined || reachedIn > group) return;
      const tier = model.tiers[segment] as number;
      if (!best || tier < best.tier) best = { tier, segment };
    });
  }
  return (model.segments[(best as { segment: number }).segment] as ChannelSegment).channel;
}
