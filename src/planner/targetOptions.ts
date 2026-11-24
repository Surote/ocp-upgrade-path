import type { ChannelSegment } from '../engine/lookahead';
import { shortestPathsFrom } from '../engine/pathfinder';
import { routeAcrossSegments } from '../engine/stitch';
import { compareVersions, formatStream, streamOf } from '../engine/version';
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
 */
export function buildTargetOptions(
  anchor: Graph,
  start: Version,
  segments: readonly ChannelSegment[],
): readonly TargetOption[] {
  const inAnchor = shortestPathsFrom(anchor, start);
  // The anchor's channel name never surfaces: routes are read only for
  // versions outside the anchor, whose last hop is on a look-ahead segment.
  const routes = routeAcrossSegments([{ channel: '', graph: anchor, classFallback: false }, ...segments], start);
  const isCandidate = (version: Version) => version !== start && compareVersions(version, start) >= 0;
  const options = new Map<Version, TargetOption>();

  for (const { version } of anchor.nodes) {
    if (isCandidate(version)) options.set(version, { version, reachable: inAnchor.has(version), via: undefined });
  }
  for (const segment of segments) {
    for (const { version } of segment.graph.nodes) {
      if (options.has(version) || !isCandidate(version)) continue;
      const route = routes.get(version);
      const via = route
        ? { channel: route.hops.at(-1)?.sourceChannel as string, classFallback: route.fallbackHops.some((n) => n > 0) }
        : { channel: segment.channel, classFallback: segment.classFallback };
      options.set(version, { version, reachable: route !== undefined, via });
    }
  }

  return [...options.values()].sort((a, b) => compareVersions(b.version, a.version));
}

export function versionStream(version: Version): string {
  return formatStream(streamOf(version));
}
