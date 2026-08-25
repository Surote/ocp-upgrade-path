import type { Graph, NodeIndex, Version } from '../graph/types';
import { err, ok, type Result } from '../lib/result';
import { dedupeRisks, RiskIndex, riskWeight } from './risks';
import { compareVersions, parseVersion } from './version';
import type { FindPathSuccess, NoPathReason, Path, PathCost, PathHop } from './types';

/**
 * The running cost tuple used internally by Dijkstra -- structurally identical
 * to the public `PathCost`, aliased rather than duplicated.
 */
type CostTuple = PathCost;

const ZERO_COST: CostTuple = { hops: 0, riskWeight: 0, tieBreak: 0 };

/**
 * Lexicographic comparison of two cost tuples: hops first, then risk weight,
 * then the patch-level tie-break. Negative if `a` is cheaper than `b`.
 *
 * A note on why summing `tieBreak` (`-patch(to)` per edge, per plan.md §4) is
 * sound as a Dijkstra edge cost even though it isn't itself non-negative:
 * standard Dijkstra requires that extending any path by one more edge cannot
 * make its cost *smaller* in the ordering used, so that once a node is popped
 * with a tentative-minimum cost, nothing still in the queue could ever produce
 * a cheaper route to it. That requirement is usually phrased as "edge weights
 * must be non-negative" for a *scalar* cost, but the tuple here is compared
 * *lexicographically*, and the hop-count component is a strictly-positive
 * literal `+1` on every single edge. In lexicographic order, if the leading
 * component of X is strictly greater than the leading component of Y, then
 * X > Y regardless of every other component -- so `cost(path) ⊕ edgeCost` is
 * *always* strictly greater than `cost(path)`, no matter the sign or
 * magnitude of the risk-weight or tie-break components. The monotonicity
 * Dijkstra needs falls out entirely from the leading component; the sign of
 * `tieBreak` is irrelevant to it. This was verified by proof, not assumption,
 * before implementing it literally -- see pathfinder.test.ts for a
 * regression case that would catch a broken comparator.
 */
function compareCost(a: CostTuple, b: CostTuple): number {
  if (a.hops !== b.hops) return a.hops - b.hops;
  if (a.riskWeight !== b.riskWeight) return a.riskWeight - b.riskWeight;
  return a.tieBreak - b.tieBreak;
}

function addEdge(cost: CostTuple, edgeRiskWeight: number, toPatch: number): CostTuple {
  return { hops: cost.hops + 1, riskWeight: cost.riskWeight + edgeRiskWeight, tieBreak: cost.tieBreak - toPatch };
}

function combineCost(a: CostTuple, b: CostTuple): CostTuple {
  return { hops: a.hops + b.hops, riskWeight: a.riskWeight + b.riskWeight, tieBreak: a.tieBreak + b.tieBreak };
}

/**
 * Forward and reverse adjacency, indexed by `NodeIndex` (which is exactly the
 * node's position in `graph.nodes`, per graph/types.ts -- so these arrays are
 * plain index-addressed lookups, not a re-mint of the brand from anything
 * outside the graph's own established index space).
 */
function buildAdjacency(graph: Graph): { forward: NodeIndex[][]; reverse: NodeIndex[][] } {
  const n = graph.nodes.length;
  const forward: NodeIndex[][] = Array.from({ length: n }, () => []);
  const reverse: NodeIndex[][] = Array.from({ length: n }, () => []);
  for (const [from, to] of graph.edges) {
    (forward[from] as NodeIndex[]).push(to);
    (reverse[to] as NodeIndex[]).push(from);
  }
  return { forward, reverse };
}

type Direction = 'forward' | 'backward';

/**
 * Builds the per-step edge-cost function for `dijkstra` below. `direction`
 * says which way the *traversal* moves relative to the *original* directed
 * edges: a 'forward' run walks `forward` adjacency, so `(current, neighbor)`
 * already is `(originalFrom, originalTo)`. A 'backward' run (used for the
 * waypoint-alternates search, source = target, walking `reverse` adjacency)
 * moves from a node to its *predecessor*, so the original edge is
 * `(neighbor, current)` -- risk lookup and the patch-level tie-break (which is
 * keyed on the original edge's `to`) must use that orientation, not the
 * traversal orientation, or the backward search would silently score edges
 * against the wrong node.
 */
function makeEdgeCost(riskIndex: RiskIndex, versions: readonly Version[], direction: Direction) {
  return (current: NodeIndex, neighbor: NodeIndex): { readonly riskWeight: number; readonly toPatch: number } => {
    const [origFrom, origTo] =
      direction === 'forward' ? [current, neighbor] : [neighbor, current];
    const risks = riskIndex.risksFor(versions[origFrom] as Version, versions[origTo] as Version);
    return { riskWeight: riskWeight(risks), toPatch: parseVersion(versions[origTo] as Version).patch };
  };
}

interface DijkstraResult {
  readonly dist: readonly (CostTuple | undefined)[];
  /** `pred[x]` = the node this traversal reached `x` from. For a forward run
   * (source = start), this is `x`'s predecessor on the shortest path from
   * start. For a backward run (source = target, walking reverse adjacency),
   * it is `x`'s *successor* toward target -- i.e. `pred[x]` is the next hop
   * from `x` on `x`'s shortest route to target. */
  readonly pred: readonly (NodeIndex | undefined)[];
}

/**
 * Lexicographic Dijkstra, per plan.md §4. Dijkstra (not a topological DP) was
 * chosen deliberately so the search stays correct even if the graph ever
 * contains a cycle -- `stable-4.20` has 0 non-forward edges today, but nothing
 * here assumes acyclicity.
 *
 * O(V²) node selection rather than a binary heap: at this graph scale
 * (fixtures top out at a few hundred nodes even after stitching several
 * channels together), a heap is complexity the codebase would carry for no
 * measurable benefit.
 */
function dijkstra(
  n: number,
  adjacency: readonly (readonly NodeIndex[])[],
  edgeCost: (current: NodeIndex, neighbor: NodeIndex) => { readonly riskWeight: number; readonly toPatch: number },
  source: NodeIndex,
): DijkstraResult {
  const dist: (CostTuple | undefined)[] = new Array(n).fill(undefined);
  const pred: (NodeIndex | undefined)[] = new Array(n).fill(undefined);
  const visited: boolean[] = new Array(n).fill(false);
  dist[source] = ZERO_COST;

  for (let iter = 0; iter < n; iter += 1) {
    let u: NodeIndex | undefined;
    let best: CostTuple | undefined;
    for (let i = 0; i < n; i += 1) {
      if (visited[i]) continue;
      const d = dist[i];
      if (d === undefined) continue;
      if (best === undefined || compareCost(d, best) < 0) {
        best = d;
        u = i as NodeIndex; // enumerating the graph's own 0..n-1 index space, not fabricating a foreign index
      }
    }
    if (u === undefined) break; // everything left unvisited is unreachable from source
    visited[u] = true;

    const du = dist[u] as CostTuple;
    for (const v of adjacency[u] ?? []) {
      if (visited[v]) continue;
      const { riskWeight: rw, toPatch } = edgeCost(u, v);
      const candidate = addEdge(du, rw, toPatch);
      const existing = dist[v];
      if (existing === undefined || compareCost(candidate, existing) < 0) {
        dist[v] = candidate;
        pred[v] = u;
      }
    }
  }

  return { dist, pred };
}

function buildPathFromChain(
  versions: readonly Version[],
  riskIndex: RiskIndex,
  chain: readonly NodeIndex[],
  cost: CostTuple,
): Path {
  const pathVersions = chain.map((i) => versions[i] as Version);
  const hops: PathHop[] = [];
  for (let i = 0; i < pathVersions.length - 1; i += 1) {
    const from = pathVersions[i] as Version;
    const to = pathVersions[i + 1] as Version;
    hops.push({ from, to, risks: riskIndex.risksFor(from, to) });
  }
  return {
    versions: pathVersions,
    hops,
    cost,
    riskSummary: dedupeRisks(hops.map((h) => h.risks)),
  };
}

function reconstructForwardChain(fwdPred: readonly (NodeIndex | undefined)[], startIdx: NodeIndex, endIdx: NodeIndex): NodeIndex[] {
  const chain: NodeIndex[] = [];
  let cur: NodeIndex | undefined = endIdx;
  while (cur !== undefined) {
    chain.push(cur);
    if (cur === startIdx) break;
    cur = fwdPred[cur];
  }
  chain.reverse();
  return chain;
}

/** Walks `bwdPred`'s "next hop toward target" chain from `fromIdx` (exclusive) to `targetIdx` (inclusive). */
function reconstructBackwardChain(
  bwdPred: readonly (NodeIndex | undefined)[],
  fromIdx: NodeIndex,
  targetIdx: NodeIndex,
): NodeIndex[] | undefined {
  const chain: NodeIndex[] = [];
  let cur = fromIdx;
  while (cur !== targetIdx) {
    const next = bwdPred[cur];
    if (next === undefined) return undefined; // should not happen if dist was defined, but stay defensive
    chain.push(next);
    cur = next;
  }
  return chain;
}

function trivialPath(version: Version): Path {
  return { versions: [version], hops: [], cost: ZERO_COST, riskSummary: [] };
}

/**
 * Among nodes reachable from `start` (i.e. present in `dist`), finds the
 * version "closest" to `target`: the highest reachable version at or below
 * `target` if one exists, else the lowest reachable version above it. Powers
 * the "nearest reachable target" the UI can offer as a retry (plan.md §4).
 * `start` itself is excluded -- suggesting the version already running back
 * as a "target" isn't useful.
 */
function closestReachableVersion(
  target: Version,
  versions: readonly Version[],
  dist: readonly (CostTuple | undefined)[],
  excludeIdx: NodeIndex,
): Version | undefined {
  let bestBelow: Version | undefined;
  let bestAbove: Version | undefined;
  for (let i = 0; i < versions.length; i += 1) {
    if (i === excludeIdx || dist[i] === undefined) continue;
    const ver = versions[i] as Version;
    if (compareVersions(ver, target) <= 0) {
      if (bestBelow === undefined || compareVersions(ver, bestBelow) > 0) bestBelow = ver;
    } else if (bestAbove === undefined || compareVersions(ver, bestAbove) < 0) {
      bestAbove = ver;
    }
  }
  return bestBelow ?? bestAbove;
}

/**
 * The waypoint signature (plan.md §4): the sequence of versions where the
 * path first enters each intermediate minor -- minors strictly between the
 * start's and the target's. Two paths with the same signature are considered
 * the "same" upgrade shape for alternates purposes, even if they differ in
 * which patch they land on within the start or target minor itself.
 */
function waypointSignature(pathVersions: readonly Version[], startMinor: number, targetMinor: number): string {
  const seenMinors = new Set<number>();
  const parts: string[] = [];
  for (const ver of pathVersions) {
    const minor = parseVersion(ver).minor;
    if (minor > startMinor && minor < targetMinor && !seenMinors.has(minor)) {
      seenMinors.add(minor);
      parts.push(`${minor}:${ver}`);
    }
  }
  return parts.join('|');
}

/**
 * Best path per distinct intermediate-minor waypoint, capped at 2 (plus the
 * primary makes 3 total) -- per plan.md §4 / Q12. Not k-shortest-paths: rather
 * than enumerate paths and rank them (infeasible -- a naive BFS at depth ≤5
 * found 45,563 paths for the verified example), this composes each candidate
 * from two independent shortest-path trees: forward from `start` (already
 * computed for the primary) and backward from `target` over reverse adjacency.
 * For every node in an intermediate minor reachable from both directions, the
 * concatenation of its two optimal half-paths is *a* valid start→target path
 * (Dijkstra's optimal-substructure property), and by definition no cheaper
 * than the primary (which is the global minimum over all such paths) -- so
 * candidates are grouped by waypoint signature and only ties/near-ties survive
 * as genuine alternates.
 */
function findWaypointAlternates(
  versions: readonly Version[],
  riskIndex: RiskIndex,
  fwd: DijkstraResult,
  bwd: DijkstraResult,
  startIdx: NodeIndex,
  targetIdx: NodeIndex,
  primary: Path,
): readonly Path[] {
  const startMinor = parseVersion(versions[startIdx] as Version).minor;
  const targetMinor = parseVersion(versions[targetIdx] as Version).minor;
  if (targetMinor - startMinor < 2) return []; // no minor can lie strictly between them

  const primarySignature = waypointSignature(primary.versions, startMinor, targetMinor);
  const bestPerSignature = new Map<string, Path>([[primarySignature, primary]]);

  for (let i = 0; i < versions.length; i += 1) {
    if (i === startIdx || i === targetIdx) continue;
    const minor = parseVersion(versions[i] as Version).minor;
    if (minor <= startMinor || minor >= targetMinor) continue;

    const waypointIdx = i as NodeIndex;
    const df = fwd.dist[waypointIdx];
    const db = bwd.dist[waypointIdx];
    if (df === undefined || db === undefined) continue;

    const forwardChain = reconstructForwardChain(fwd.pred, startIdx, waypointIdx);
    const backwardChain = reconstructBackwardChain(bwd.pred, waypointIdx, targetIdx);
    if (backwardChain === undefined) continue;

    // Defend against a degenerate concatenation that would revisit a node
    // (possible only if the graph has an unexpected cycle) -- such a
    // "path" isn't a real upgrade sequence and must not be offered as one.
    const forwardSet = new Set(forwardChain);
    if (backwardChain.some((node) => forwardSet.has(node))) continue;

    const chain = [...forwardChain, ...backwardChain];
    const candidate = buildPathFromChain(versions, riskIndex, chain, combineCost(df, db));
    const signature = waypointSignature(candidate.versions, startMinor, targetMinor);

    const existing = bestPerSignature.get(signature);
    if (!existing || compareCost(candidate.cost, existing.cost) < 0) {
      bestPerSignature.set(signature, candidate);
    }
  }

  return [...bestPerSignature.entries()]
    .filter(([signature]) => signature !== primarySignature)
    .map(([, path]) => path)
    .sort((a, b) => compareCost(a.cost, b.cost))
    .slice(0, 2);
}

/**
 * Finds the recommended upgrade path from `start` to `target` within a single
 * `Graph`, plus up to two waypoint alternates, per plan.md §4. Pure: no
 * network, no `GraphClient` -- callers (including the stitcher, engine/stitch.ts)
 * supply the `Graph` they've already fetched/validated.
 */
export function findPathsInGraph(graph: Graph, start: Version, target: Version): Result<FindPathSuccess, NoPathReason> {
  const versions = graph.nodes.map((n) => n.version);
  const indexOfVersion = new Map<Version, NodeIndex>();
  versions.forEach((ver, i) => indexOfVersion.set(ver, i as NodeIndex));

  const startIdx = indexOfVersion.get(start);
  if (startIdx === undefined) {
    return err({ kind: 'startNotFound', start });
  }

  if (compareVersions(target, start) < 0) {
    return err({ kind: 'targetOlder', start, target });
  }

  if (start === target) {
    return ok({ primary: trivialPath(start), alternates: [] });
  }

  const riskIndex = new RiskIndex(graph.conditionalEdges);
  const { forward, reverse } = buildAdjacency(graph);
  const n = graph.nodes.length;

  const fwd = dijkstra(n, forward, makeEdgeCost(riskIndex, versions, 'forward'), startIdx);

  const targetIdx = indexOfVersion.get(target);
  const targetDist = targetIdx !== undefined ? fwd.dist[targetIdx] : undefined;
  if (targetIdx === undefined || targetDist === undefined) {
    const nearestReachable = closestReachableVersion(target, versions, fwd.dist, startIdx);
    return err({ kind: 'unreachable', start, target, nearestReachable });
  }

  const primaryChain = reconstructForwardChain(fwd.pred, startIdx, targetIdx);
  const primary = buildPathFromChain(versions, riskIndex, primaryChain, targetDist);

  const bwd = dijkstra(n, reverse, makeEdgeCost(riskIndex, versions, 'backward'), targetIdx);
  const alternates = findWaypointAlternates(versions, riskIndex, fwd, bwd, startIdx, targetIdx, primary);

  return ok({ primary, alternates });
}
