import { parseChannelName } from '../design/channels';
import { FALLBACK_CLASSES } from '../design/forwardChannel';
import type { Graph, GraphNode, Risk, Version } from '../graph/types';
import type { ChannelSegment } from './lookahead';
import { riskClass, RiskIndex } from './risks';
import type { RiskPolicy, RouteConstraints } from './routeConstraints';
import { compareVersions, parseVersion } from './version';
import type { PathCost, PathHop } from './types';

/**
 * The route search behind both the stitcher (engine/stitch.ts) and the
 * dropdowns (planner/targetOptions.ts, `buildStopOptions`), so an option they
 * offer is one the stitcher routes.
 *
 * Segments are ordered by stream (backward walk, anchor, look-ahead). A
 * route never returns to an earlier stream's channel, but channels of one
 * stream form a group it moves between freely: fast-5.0 can enter 5.0, a hop
 * only stable-5.0 publishes can follow, and fast-5.0 can supply the next.
 * Each hop walks one segment's own edge with that segment's risks, and is
 * labelled with it: edges are never merged across graphs (stitch.ts).
 */

/** One edge of one graph, minus downgrades, with that graph's risks for it. */
export interface Edge {
  readonly from: Version;
  readonly to: Version;
  readonly risks: readonly Risk[];
  readonly always: number;
  readonly conditional: number;
  readonly toPatch: number;
}

interface Adjacency {
  readonly out: ReadonlyMap<Version, readonly Edge[]>;
  readonly in: ReadonlyMap<Version, readonly Edge[]>;
}

export interface RoutingModel {
  readonly segments: readonly ChannelSegment[];
  /** Per segment. */
  readonly adjacency: readonly Adjacency[];
  /** Per segment: its index in `FALLBACK_CLASSES` when it is a class fallback, else -1. */
  readonly tiers: readonly number[];
  /** Segment indices per group of consecutive segments of one stream. */
  readonly groups: readonly (readonly number[])[];
}

function push<K, T>(map: Map<K, T[]>, key: K, value: T): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

// Graphs are immutable, and the planner searches the same anchor and
// look-ahead graphs on every start, target and stop change.
const adjacencyCache = new WeakMap<Graph, Adjacency>();

function adjacencyOf(graph: Graph): Adjacency {
  const cached = adjacencyCache.get(graph);
  if (cached) return cached;
  const { nodes, edges, conditionalEdges } = graph;
  const byPrecedence = nodes.map((_, i) => i).sort((a, b) => compareVersions((nodes[a] as GraphNode).version, (nodes[b] as GraphNode).version));
  const precedence = new Array<number>(nodes.length);
  byPrecedence.forEach((index, position) => {
    const previous = byPrecedence[position - 1];
    const tied = previous !== undefined && compareVersions((nodes[previous] as GraphNode).version, (nodes[index] as GraphNode).version) === 0;
    precedence[index] = tied ? (precedence[previous] as number) : position;
  });

  const patches = nodes.map((node) => parseVersion(node.version).patch);
  const riskIndex = new RiskIndex(conditionalEdges);
  const out = new Map<Version, Edge[]>();
  const into = new Map<Version, Edge[]>();
  for (const [fromIdx, toIdx] of edges) {
    // An upgrade plan never steps back; a build of the same release is a real hop.
    if ((precedence[toIdx] as number) < (precedence[fromIdx] as number)) continue;
    const from = (nodes[fromIdx] as GraphNode).version;
    const to = (nodes[toIdx] as GraphNode).version;
    const risks = riskIndex.risksFor(from, to);
    const always = risks.length === 0 ? 0 : risks.filter((risk) => riskClass(risk) === 'Always').length;
    const edge: Edge = { from, to, risks, always, conditional: risks.length - always, toPatch: patches[toIdx] as number };
    push(out, from, edge);
    push(into, to, edge);
  }
  const adjacency = { out, in: into };
  adjacencyCache.set(graph, adjacency);
  return adjacency;
}

export function buildRoutingModel(segments: readonly ChannelSegment[]): RoutingModel {
  const groups: number[][] = [];
  let previousStream: string | undefined;
  segments.forEach((segment, index) => {
    const parsed = parseChannelName(segment.channel);
    const stream = parsed && `${parsed.major}.${parsed.minor}`;
    if (stream === undefined || stream !== previousStream) groups.push([]);
    previousStream = stream;
    (groups[groups.length - 1] as number[]).push(index);
  });
  return {
    segments,
    adjacency: segments.map((segment) => adjacencyOf(segment.graph)),
    tiers: segments.map((segment) =>
      segment.classFallback ? FALLBACK_CLASSES.indexOf(parseChannelName(segment.channel)?.cls as string) : -1,
    ),
    groups,
  };
}

/** Every edge leaving (`out`) or entering (`in`) `version` in `group`, with the segment supplying it. */
export function forEachEdge(
  model: RoutingModel,
  group: readonly number[],
  direction: keyof Adjacency,
  version: Version,
  visit: (edge: Edge, segment: number) => void,
): void {
  for (const segment of group) {
    for (const edge of (model.adjacency[segment] as Adjacency)[direction].get(version) ?? []) visit(edge, segment);
  }
}

function touches(model: RoutingModel, group: readonly number[], direction: keyof Adjacency, version: Version): boolean {
  return group.some((segment) => (model.adjacency[segment] as Adjacency)[direction].has(version));
}

export interface Route {
  readonly cost: PathCost;
  /**
   * Hops walked on a class-fallback segment, counted per class in
   * `FALLBACK_CLASSES` order (stable, fast, candidate): time spent off the
   * anchor's class.
   */
  readonly fallbackHops: readonly number[];
  /** Risk occurrences summed per hop, so one risk on two hops counts twice. */
  readonly always: number;
  readonly conditional: number;
  /** Each hop's `sourceChannel` names the segment whose own edge it walks. */
  readonly hops: readonly PathHop[];
}

type Rank = Omit<Route, 'hops'>;

const NO_FALLBACK_HOPS: readonly number[] = FALLBACK_CLASSES.map(() => 0);

function comparePosture(a: Rank, b: Rank): number {
  for (let tier = FALLBACK_CLASSES.length - 1; tier >= 0; tier -= 1) {
    const diff = (a.fallbackHops[tier] as number) - (b.fallbackHops[tier] as number);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Support posture before anything else (plan.md §6 "Forward channel
 * preference"): fewest hops on candidate, then fast, then a stable fallback.
 * A release the anchor's class reaches in five hops is not worth moving a
 * production cluster onto candidate to save one, nor to dodge a risk. Every
 * term is a per-hop sum and each hop adds one to `hops`, which every order
 * ranks ahead of the tie-break, so each stays a valid shortest-path cost.
 */
const RANKINGS: Readonly<Record<RiskPolicy, (a: Rank, b: Rank) => number>> = {
  recommended: (a, b) =>
    comparePosture(a, b) || a.cost.hops - b.cost.hops || a.cost.riskWeight - b.cost.riskWeight || a.cost.tieBreak - b.cost.tieBreak,
  avoidConditional: (a, b) =>
    comparePosture(a, b) || a.always - b.always || a.conditional - b.conditional || a.cost.hops - b.cost.hops || a.cost.tieBreak - b.cost.tieBreak,
};

function step(rank: Rank, arc: Edge, tier: number): Rank {
  return {
    cost: {
      hops: rank.cost.hops + 1,
      riskWeight: rank.cost.riskWeight + 2 * arc.always + arc.conditional,
      tieBreak: rank.cost.tieBreak - arc.toPatch,
    },
    fallbackHops: tier < 0 ? rank.fallbackHops : rank.fallbackHops.map((n, i) => (i === tier ? n + 1 : n)),
    always: rank.always + arc.always,
    conditional: rank.conditional + arc.conditional,
  };
}

interface Entry {
  readonly layer: number;
  readonly version: Version;
  readonly rank: Rank;
  /** Set on an entry that starts this group's search from a route found earlier. */
  readonly seed?: Route;
  readonly prev?: Entry;
  readonly edge?: Edge;
  readonly segment?: number;
}

/** Binary min-heap; equal keys pop in insertion order, so ties keep the route found first. */
class Heap<T> {
  private readonly items: { value: T; order: number }[] = [];
  private pushed = 0;
  private readonly compare: (a: T, b: T) => number;

  constructor(compare: (a: T, b: T) => number) {
    this.compare = compare;
  }

  get size(): number {
    return this.items.length;
  }

  private less(i: number, j: number): boolean {
    const a = this.items[i] as { value: T; order: number };
    const b = this.items[j] as { value: T; order: number };
    return (this.compare(a.value, b.value) || a.order - b.order) < 0;
  }

  private swap(i: number, j: number): void {
    [this.items[i], this.items[j]] = [this.items[j] as { value: T; order: number }, this.items[i] as { value: T; order: number }];
  }

  push(value: T): void {
    this.items.push({ value, order: this.pushed++ });
    for (let i = this.items.length - 1; i > 0; ) {
      const parent = (i - 1) >> 1;
      if (!this.less(i, parent)) break;
      this.swap(i, parent);
      i = parent;
    }
  }

  pop(): T | undefined {
    const top = this.items[0];
    const last = this.items.pop();
    if (top === undefined || last === undefined || this.items.length === 0) return top?.value;
    this.items[0] = last;
    for (let i = 0; ; ) {
      const left = 2 * i + 1;
      const right = left + 1;
      let smallest = i;
      if (left < this.items.length && this.less(left, smallest)) smallest = left;
      if (right < this.items.length && this.less(right, smallest)) smallest = right;
      if (smallest === i) break;
      this.swap(i, smallest);
      i = smallest;
    }
    return top.value;
  }
}

/** The layer a route is in after a hop to `to` from `layer`: the count of stops passed, in order. */
export function layerAfter(stops: readonly Version[], layer: number, to: Version): number {
  return layer < stops.length && stops[layer] === to ? layer + 1 : layer;
}

/**
 * The best route from `start` to every version, per layer: entry `k` holds
 * routes that have passed the first `k` stops in order, so the last entry
 * holds the routes that honor every stop. A layered shortest-path DP: each
 * group is searched once (Dijkstra over version and layer), seeded at every
 * version a route already reaches with that route's cost, and the frontier
 * carries across groups, so a group can contribute no hops. A stop advances
 * the layer and keeps the incoming channel; the next hop switches only if
 * another segment supplies it.
 */
export function searchRoutes(
  model: RoutingModel,
  start: Version,
  constraints: RouteConstraints,
): readonly ReadonlyMap<Version, Route>[] {
  const { stops, riskPolicy } = constraints;
  const compare = RANKINGS[riskPolicy];
  const frontier: Map<Version, Route>[] = Array.from({ length: stops.length + 1 }, () => new Map());
  (frontier[0] as Map<Version, Route>).set(start, {
    cost: { hops: 0, riskWeight: 0, tieBreak: 0 },
    fallbackHops: NO_FALLBACK_HOPS,
    always: 0,
    conditional: 0,
    hops: [],
  });

  for (const group of model.groups) {
    const best: Map<Version, Entry>[] = frontier.map(() => new Map());
    const heap = new Heap<Entry>((a, b) => compare(a.rank, b.rank));
    frontier.forEach((routes, layer) => {
      for (const [version, route] of routes) {
        if (!touches(model, group, 'out', version)) continue;
        const entry: Entry = { layer, version, rank: route, seed: route };
        (best[layer] as Map<Version, Entry>).set(version, entry);
        heap.push(entry);
      }
    });

    const settled: Entry[] = [];
    while (heap.size > 0) {
      const entry = heap.pop() as Entry;
      if ((best[entry.layer] as Map<Version, Entry>).get(entry.version) !== entry) continue;
      settled.push(entry);
      forEachEdge(model, group, 'out', entry.version, (edge, segment) => {
        const layer = layerAfter(stops, entry.layer, edge.to);
        const rank = step(entry.rank, edge, model.tiers[segment] as number);
        const existing = (best[layer] as Map<Version, Entry>).get(edge.to);
        if (existing && compare(rank, existing.rank) >= 0) return;
        const next: Entry = { layer, version: edge.to, rank, prev: entry, edge, segment };
        (best[layer] as Map<Version, Entry>).set(edge.to, next);
        heap.push(next);
      });
    }

    for (const entry of settled) {
      if (entry.seed) continue;
      const routes = frontier[entry.layer] as Map<Version, Route>;
      const existing = routes.get(entry.version);
      if (existing && compare(entry.rank, existing) >= 0) continue;
      routes.set(entry.version, { ...entry.rank, hops: hopsOf(entry, model) });
    }
  }
  return frontier;
}

function hopsOf(entry: Entry, model: RoutingModel): readonly PathHop[] {
  const hops: PathHop[] = [];
  let cursor: Entry | undefined = entry;
  for (; cursor && !cursor.seed; cursor = cursor.prev) {
    const { from, to, risks } = cursor.edge as Edge;
    hops.push({ from, to, risks, sourceChannel: (model.segments[cursor.segment as number] as ChannelSegment).channel });
  }
  return [...(cursor?.seed?.hops ?? []), ...hops.reverse()];
}

/**
 * The best route from `start` to every version reachable through `segments`,
 * honoring `constraints`. Both the target dropdown (planner/targetOptions.ts)
 * and `stitchAndFindPath` read their answer from this search, so a target the
 * dropdown marks reachable is one the stitcher routes, through the same
 * channels.
 */
export function routeAcrossSegments(
  segments: readonly ChannelSegment[],
  start: Version,
  constraints: RouteConstraints = { stops: [], riskPolicy: 'recommended' },
): ReadonlyMap<Version, Route> {
  return searchRoutes(buildRoutingModel(segments), start, constraints).at(-1) as ReadonlyMap<Version, Route>;
}

/**
 * Where routes through `stops` can stand once past them all: each version
 * mapped to the earliest group a route reaches it in. Unweighted, over the
 * same transitions as `searchRoutes`.
 */
export function reachForward(model: RoutingModel, start: Version, stops: readonly Version[]): ReadonlyMap<Version, number> {
  const layers: Map<Version, number>[] = Array.from({ length: stops.length + 1 }, () => new Map());
  (layers[0] as Map<Version, number>).set(start, 0);
  model.groups.forEach((group, g) => {
    layers.forEach((reached, layer) => {
      const queue = [...reached.keys()].filter((version) => touches(model, group, 'out', version));
      for (let version = queue.pop(); version !== undefined; version = queue.pop()) {
        forEachEdge(model, group, 'out', version, ({ to }) => {
          const next = layerAfter(stops, layer, to);
          const target = layers[next] as Map<Version, number>;
          if (target.has(to)) return;
          target.set(to, g);
          if (next === layer) queue.push(to);
        });
      }
    });
  });
  return layers.at(-1) as ReadonlyMap<Version, number>;
}

/**
 * The mirror of `reachForward`: every version from which a route through
 * `stops` reaches `target`, mapped to the latest group such a route can
 * start in (it uses only that group and later ones).
 */
export function reachBackward(model: RoutingModel, target: Version, stops: readonly Version[]): ReadonlyMap<Version, number> {
  const layers: Map<Version, number>[] = Array.from({ length: stops.length + 1 }, () => new Map());
  (layers[stops.length] as Map<Version, number>).set(target, model.groups.length - 1);
  for (let g = model.groups.length - 1; g >= 0; g -= 1) {
    const group = model.groups[g] as readonly number[];
    for (let layer = stops.length; layer >= 0; layer -= 1) {
      const reached = layers[layer] as Map<Version, number>;
      const queue = [...reached.keys()].filter((version) => touches(model, group, 'in', version));
      for (let version = queue.pop(); version !== undefined; version = queue.pop()) {
        const to = version;
        forEachEdge(model, group, 'in', to, ({ from }) => {
          // The layers a hop into `to` can leave from and still land in `layer`.
          for (const fromLayer of [layer - 1, layer]) {
            if (fromLayer < 0 || layerAfter(stops, fromLayer, to) !== layer) continue;
            const source = layers[fromLayer] as Map<Version, number>;
            if (source.has(from)) continue;
            source.set(from, g);
            if (fromLayer === layer) queue.push(from);
          }
        });
      }
    }
  }
  return layers[0] as ReadonlyMap<Version, number>;
}
