import { reachableFrom } from '../engine/reachability';
import { compareVersions, formatStream, streamOf } from '../engine/version';
import type { Graph, Version } from '../graph/types';
import type { LookaheadSegment } from './lookaheadTargets';

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
 * `4.22.1-rc.1`) ranks equal in SemVer yet is a real hop, so it stays. A
 * version in the anchor wins over the same version in a segment.
 *
 * Reachability carries a frontier from `start` through the anchor and then
 * each segment in turn, walking only that graph's own edges (plan.md §4:
 * never union edges across graphs). The frontier is the union over every
 * earlier graph, because successor streams can be siblings (4.23 and 5.0
 * both follow 4.22) rather than a chain.
 */
export function buildTargetOptions(
  anchor: Graph,
  start: Version,
  segments: readonly LookaheadSegment[],
): readonly TargetOption[] {
  const sources = [
    { graph: anchor, via: undefined },
    ...segments.map((s) => ({ graph: s.graph, via: { channel: s.channel, classFallback: s.classFallback } })),
  ];
  const seen = new Set<Version>();
  let frontier: ReadonlySet<Version> = new Set([start]);
  const options: TargetOption[] = [];

  for (const { graph, via } of sources) {
    const reachable = new Set<Version>();
    for (const { version } of graph.nodes) {
      if (frontier.has(version)) for (const next of reachableFrom(graph, version)) reachable.add(next);
    }
    for (const { version } of graph.nodes) {
      if (seen.has(version)) continue;
      seen.add(version);
      if (version !== start && compareVersions(version, start) >= 0) options.push({ version, reachable: reachable.has(version), via });
    }
    frontier = new Set([...frontier, ...reachable]);
  }

  return options.sort((a, b) => compareVersions(b.version, a.version));
}

export function versionStream(version: Version): string {
  return formatStream(streamOf(version));
}
