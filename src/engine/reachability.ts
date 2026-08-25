import type { Graph, NodeIndex, Version } from '../graph/types';

/**
 * All versions reachable from `start` by following directed edges forward,
 * computed with a single breadth-first traversal over the graph's forward
 * adjacency -- O(V+E), and independent of risk weighting (reachability is a
 * structural question; the lexicographic-Dijkstra cost tuple `findPathsInGraph`
 * computes is not needed to answer it).
 *
 * Exists so the target dropdown can grey out every unreachable candidate
 * (plan.md §6: "the target list contains only genuinely reachable releases;
 * unreachable ones are greyed with the reason attached") with exactly one
 * traversal of the graph, instead of running `findPathsInGraph` -- a full
 * lexicographic Dijkstra -- once per candidate target, which would be O(n)
 * shortest-path searches for an n-node channel graph. Deliberately lives here
 * in the engine, not inside a React component or hook: it is pure graph
 * traversal over the same `Graph`/`NodeIndex` shapes `pathfinder.ts` uses, and
 * belongs with the rest of the graph algorithms, unit-tested the same way.
 *
 * `start` itself is included in the returned set (a node is trivially
 * "reachable" from itself, at zero hops) -- callers that don't want to offer
 * the start version back as its own target filter it out themselves.
 *
 * Returns an empty set if `start` is not a node in `graph` at all -- mirrors
 * `findPathsInGraph`'s `startNotFound` case, but as a plain empty result
 * rather than a `Result` type: this function has no other failure mode to
 * report, so a `Result` wrapper would only be a shape nothing distinguishes
 * from "found nothing".
 */
export function reachableFrom(graph: Graph, start: Version): ReadonlySet<Version> {
  const indexOfVersion = new Map<Version, NodeIndex>();
  graph.nodes.forEach((n, i) => indexOfVersion.set(n.version, i as NodeIndex));

  const startIdx = indexOfVersion.get(start);
  if (startIdx === undefined) {
    return new Set();
  }

  const forward: NodeIndex[][] = Array.from({ length: graph.nodes.length }, () => []);
  for (const [from, to] of graph.edges) {
    (forward[from] as NodeIndex[]).push(to);
  }

  const visited = new Set<NodeIndex>([startIdx]);
  const queue: NodeIndex[] = [startIdx];
  let head = 0;
  while (head < queue.length) {
    const current = queue[head] as NodeIndex;
    head += 1;
    for (const next of forward[current] ?? []) {
      if (!visited.has(next)) {
        visited.add(next);
        queue.push(next);
      }
    }
  }

  const result = new Set<Version>();
  for (const idx of visited) {
    result.add(graph.nodes[idx]?.version as Version);
  }
  return result;
}
