import { reachableFrom } from '../engine/reachability';
import { compareVersions } from '../engine/version';
import type { Graph, Version } from '../graph/types';

/** Newest-first version list for the start dropdown (plan.md §6 / Q7 -- "sorted with compareVersions, newest first"). */
export function buildStartOptions(graph: Graph): readonly Version[] {
  return [...graph.nodes.map((n) => n.version)].sort((a, b) => compareVersions(b, a));
}

export interface TargetOption {
  readonly version: Version;
  readonly disabled: boolean;
  /** Present whenever `disabled` is true -- the reason a screen reader (and a sighted user) sees, not conveyed by styling alone (plan.md §6). */
  readonly reason?: string;
}

/**
 * Builds the target dropdown's option list for one already-fetched `Graph`,
 * given the selected `start` version: every other version in the graph,
 * newest first, each marked reachable or not. Uses `reachableFrom` (a single
 * O(V+E) traversal) rather than calling `findPathsInGraph` once per
 * candidate -- see engine/reachability.ts.
 *
 * Per plan.md §6, unreachable targets are *disabled with the reason
 * attached*, not omitted from the list -- so this always returns one entry
 * per other node in the graph.
 */
export function buildTargetOptions(graph: Graph, start: Version): readonly TargetOption[] {
  const reachable = reachableFrom(graph, start);
  const versions = [...graph.nodes.map((n) => n.version)]
    .filter((ver) => ver !== start)
    .sort((a, b) => compareVersions(b, a));

  return versions.map((version) => {
    if (compareVersions(version, start) < 0) {
      return { version, disabled: true, reason: 'older than the selected start version' };
    }
    if (!reachable.has(version)) {
      return { version, disabled: true, reason: 'not reachable from the selected start version in this channel' };
    }
    return { version, disabled: false };
  });
}
