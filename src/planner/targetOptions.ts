import type { ChannelSegment } from '../engine/lookahead';
import { shortestPathsFrom } from '../engine/pathfinder';
import { NO_CONSTRAINTS, type RouteConstraints } from '../engine/routeConstraints';
import { routeAcrossSegments } from '../engine/stitch';
import { parseChannelName } from '../design/channels';
import { compareVersions, formatStream, parseVersion, streamOf } from '../engine/version';
import type { Graph, Version } from '../graph/types';

/** Newest-first version list for the start dropdown (plan.md §6 / Q7 -- "sorted with compareVersions, newest first"). */
export function buildStartOptions(graph: Graph): readonly Version[] {
  return [...graph.nodes.map((n) => n.version)].sort((a, b) => compareVersions(b, a));
}

export interface TargetOption {
  readonly version: Version;
  /** Unreachable targets stay listed, disabled, rather than omitted (plan.md §6). */
  readonly reachable: boolean;
  /** Present when the version lives only beyond the selected channel, so choosing it means a channel change. */
  readonly via?: { readonly channel: string; readonly classFallback: boolean };
}

/**
 * One newest-first list of every version other than `start` that does not
 * rank below it, across the selected (anchor) channel and its look-ahead
 * segments. A build of the start release (`4.22.1-rc.1+build.1` from
 * `4.22.1-rc.1`) ranks equal in SemVer yet is a real hop, so it stays.
 *
 * A version in the anchor is reachable when the anchor's own edges reach it,
 * exactly the stitcher's single-graph case. Any other version is reachable
 * when `routeAcrossSegments` -- the route search the stitcher itself uses --
 * finds a route to it, and `via` names the channel that route ends on, so
 * choosing a reachable option always yields that path. `classFallback` is
 * set when any hop of the route leaves the anchor's class.
 *
 * Reachability ignores `constraints`, so a target the pinned stops can't
 * honor stays selectable and the stop is flagged instead. `via` follows the
 * route the stitcher plans under `constraints`, falling back to the
 * unconstrained route when the stops rule the target out.
 */
export function buildTargetOptions(
  anchor: Graph,
  start: Version,
  segments: readonly ChannelSegment[],
  constraints: RouteConstraints = NO_CONSTRAINTS,
): readonly TargetOption[] {
  const inAnchor = shortestPathsFrom(anchor, start);
  // The anchor's channel name never surfaces: routes are read only for
  // versions outside the anchor, whose last hop is on a look-ahead segment.
  const routed: readonly ChannelSegment[] = [{ channel: '', graph: anchor, classFallback: false }, ...segments];
  const routes = routeAcrossSegments(routed, start);
  const unconstrained = constraints.stops.length === 0 && constraints.riskPolicy === 'recommended';
  const planned = unconstrained ? routes : routeAcrossSegments(routed, start, constraints);
  const isCandidate = (version: Version) => version !== start && compareVersions(version, start) >= 0;
  const options = new Map<Version, TargetOption>();

  for (const { version } of anchor.nodes) {
    if (isCandidate(version)) options.set(version, { version, reachable: inAnchor.has(version), via: undefined });
  }
  for (const segment of segments) {
    for (const { version } of segment.graph.nodes) {
      if (options.has(version) || !isCandidate(version)) continue;
      const route = routes.get(version);
      const shown = planned.get(version) ?? route;
      const via = shown
        ? { channel: shown.hops.at(-1)?.sourceChannel as string, classFallback: shown.fallbackHops.some((n) => n > 0) }
        : { channel: segment.channel, classFallback: segment.classFallback };
      options.set(version, { version, reachable: route !== undefined, via });
    }
  }

  return [...options.values()].sort((a, b) => compareVersions(b.version, a.version));
}

/**
 * Prereleases are offered as targets and stops only from a candidate channel
 * or a prerelease start. Discovery fetches every attested channel, so a
 * stable or eus anchor would otherwise list dozens of ec and rc builds that
 * only candidate channels reach. This narrows what is offered, not routing:
 * a route may still pass through a prerelease. The selected version stays
 * listed, so a permalink to a prerelease restores with its option shown.
 */
export function offeredOptions<T extends { readonly version: Version }>(
  options: readonly T[],
  context: { readonly channel: string; readonly start: Version; readonly selected: string },
): readonly T[] {
  const { channel, start, selected } = context;
  if (parseChannelName(channel)?.cls === 'candidate' || isPrerelease(start)) return options;
  return options.filter((o) => !isPrerelease(o.version) || o.version === selected);
}

function isPrerelease(version: Version): boolean {
  return parseVersion(version).prerelease.length > 0;
}

export function versionStream(version: Version): string {
  return formatStream(streamOf(version));
}
