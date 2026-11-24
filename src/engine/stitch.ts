import { formatChannelName, parseChannelName } from '../design/channels';
import type { Arch, Graph, GraphNode, Version } from '../graph/types';
import { err, ok, type Result } from '../lib/result';
import { type ChannelSegment, discoverLookahead, type LookaheadDiscovery } from './lookahead';
import { findPathsInGraph } from './pathfinder';
import { NO_CONSTRAINTS, type RouteConstraints } from './routeConstraints';
import { buildRoutingModel, type Route, type RoutingModel, searchRoutes } from './routeSearch';
import { dedupeRisks } from './risks';
import { compareStreams, type Stream, streamOf } from './version';
import type { GraphLoader, Path, PathHop, StitchError, StitchedPathResult } from './types';

/**
 * Stitching, per plan.md §4 and §6 "Look-ahead targets (bidirectional
 * stitching)". The selected channel is an **anchor**: the graph the cluster
 * is actually on right now. It is fetched first; the stitcher then walks
 * **backward** (to older-stream channels of the same class) when the anchor
 * doesn't contain `start`, and **forward** through the look-ahead channels
 * `discoverLookahead` finds -- the same ones the target dropdown lists --
 * when it doesn't contain `target`. Neither walk computes streams by minor
 * arithmetic: the backward walk reads each segment's upgrade sources
 * (`predecessorStream`), the forward walk reads channel membership, so both
 * cross a major boundary (4.22 -> 5.0) like any other.
 * Both walks can fire on the same query -- a channel in the middle of a long
 * range can need both.
 *
 * Needed because channel span is not uniform (plan.md §3) -- `stable-4.19`
 * spans {18,19}, `stable-4.20` spans {18,19,20}, `stable-4.21` spans {20,21}
 * -- so `4.18.x -> 4.20.x` needs exactly one graph, but `4.17.x -> 4.21.x` (or,
 * new in this pass, `4.18.x -> 4.22.x` starting from `eus-4.20`) needs
 * several.
 *
 * The hard rule (plan.md §3/§4) is unchanged by bidirectionality: **never
 * union edges across graphs**. Two channel snapshots can genuinely disagree
 * about which edges into/out of an overlapping version are still valid --
 * Cincinnati actively prunes edges it later decides are unsafe (that's what
 * `previous.remove_regex` encodes), so merging edge lists from two snapshots
 * risks resurrecting a transition the *authoritative* channel no longer
 * publishes. This module never builds one merged adjacency across graphs. A
 * multi-graph stitched result is a **sequential composition of per-graph
 * shortest paths**, glued only at *nodes* -- a version present in two
 * adjacent fetched graphs -- never at edges. Every hop returned now also
 * carries `sourceChannel` (`PathHop.sourceChannel`, engine/types.ts) naming
 * exactly which fetched segment produced it -- the provenance that makes a
 * channel-switch command attributable to the correct hop (design/commands.ts).
 *
 * Node *metadata* (payload, errataUrl, channel membership) follows the same
 * provenance: the same version can have different metadata in two channel
 * snapshots, and a hop's `--to-image` digest must come from the graph the
 * cluster is on when it takes that hop. So `stations` holds only the primary
 * route's stations, each read from the graph that supplied the hop arriving
 * at it (`routeStations`).
 */

const MAX_WALK_BACK = 12; // safety bound: no real Cincinnati channel history is this deep

function versionsOf(graph: Graph): ReadonlySet<Version> {
  return new Set(graph.nodes.map((n) => n.version));
}

/**
 * The stream a channel upgrades *from*: the highest stream among its nodes
 * below the channel's own. Read from graph content because stream succession
 * is not arithmetic -- `candidate-5.0` carries 4.22.z as its upgrade sources,
 * so 5.0's predecessor is 4.22, not "5.-1". Undefined when the channel holds
 * nothing older than its own stream.
 */
function predecessorStream(graph: Graph, own: Stream): Stream | undefined {
  let best: Stream | undefined;
  for (const node of graph.nodes) {
    const stream = streamOf(node.version);
    if (compareStreams(stream, own) < 0 && (!best || compareStreams(stream, best) > 0)) best = stream;
  }
  return best;
}

/**
 * The start and each station `hops` reaches, in order, with the metadata of
 * the graph that supplied the hop arriving at it; the start with the first
 * hop's graph (the first segment's for a zero-hop route). A hop's graph
 * holds both its ends, so every lookup finds its node.
 */
function routeStations(segments: readonly ChannelSegment[], start: Version, hops: readonly PathHop[]): readonly GraphNode[] {
  const graphs = new Map(segments.map((segment) => [segment.channel, segment.graph]));
  const nodeOn = (version: Version, channel: string | undefined) =>
    graphs.get(channel as string)?.nodes.find((n) => n.version === version) as GraphNode;
  return [nodeOn(start, hops[0]?.sourceChannel ?? segments[0]?.channel), ...hops.map((hop) => nodeOn(hop.to, hop.sourceChannel))];
}

interface AnchorAndBackward {
  readonly anchor: ChannelSegment;
  /** Start-side first, anchor-adjacent last; empty when the anchor holds `start`. */
  readonly backward: readonly ChannelSegment[];
}

/**
 * Fetches the anchor channel, then -- when it lacks `start` -- walks backward
 * (same class, one stream older each step, where "older" is whatever the
 * current segment's own upgrade sources say it is) until a channel holds it.
 */
async function loadAnchorAndBackward(
  loader: GraphLoader,
  anchorChannel: string,
  arch: Arch,
  start: Version,
  loadedAnchor: Graph | undefined,
): Promise<Result<AnchorAndBackward, StitchError>> {
  const parsed = parseChannelName(anchorChannel);
  if (!parsed) {
    return err({ kind: 'invalidChannel', channel: anchorChannel });
  }

  const anchorLoaded = loadedAnchor ? ok(loadedAnchor) : await loader(anchorChannel, arch);
  if (!anchorLoaded.ok) {
    return err({ kind: 'loadFailed', channel: anchorChannel, error: anchorLoaded.error });
  }
  const anchor: ChannelSegment = { channel: anchorChannel, graph: anchorLoaded.value, classFallback: false };
  if (versionsOf(anchor.graph).has(start)) return ok({ anchor, backward: [] });

  const backward: ChannelSegment[] = []; // anchor-adjacent first while walking
  const channelsTried = [anchorChannel];
  let current = anchor;
  let currentStream: Stream = parsed;
  for (let step = 0; step < MAX_WALK_BACK; step += 1) {
    const previous = predecessorStream(current.graph, currentStream);
    if (!previous) break;
    const channel = formatChannelName({ cls: parsed.cls, ...previous });
    channelsTried.push(channel);
    const loaded = await loader(channel, arch);
    if (!loaded.ok) {
      return err({ kind: 'loadFailed', channel, error: loaded.error });
    }
    const segment: ChannelSegment = { channel, graph: loaded.value, classFallback: false };
    backward.push(segment);
    if (versionsOf(segment.graph).has(start)) return ok({ anchor, backward: backward.reverse() });
    current = segment;
    currentStream = previous;
  }
  return err({ kind: 'startNeverFound', start, channelsTried });
}

export { routeAcrossSegments } from './routeSearch';

/** An anchor graph the caller already loaded, and the look-ahead it discovered from that same graph. */
export interface AnchorSnapshot {
  readonly graph: Graph;
  readonly lookahead?: LookaheadDiscovery;
}

/**
 * Finds the recommended (and, when a single graph suffices, alternate) path
 * from `start` to `target`, fetching whichever channel graphs are needed via
 * the injected `loader`. `targetChannel` is the caller's selected channel --
 * per plan.md §6 this is the **anchor** (the channel the cluster is on now),
 * not necessarily the target's own channel: `stitchAndFindPath` walks
 * backward to cover `start` and/or forward to cover `target` as needed.
 *
 * Given `anchor`, routes against that snapshot instead of fetching the
 * anchor and rediscovering look-ahead, so the result matches target options
 * built from the same snapshot.
 *
 * `constraints` pins stops and picks the risk policy (engine/routeConstraints.ts).
 * Stops narrow the one route search rather than splitting it into legs, so
 * every channel rule applies across a stop exactly as it does elsewhere.
 */
export async function stitchAndFindPath(
  loader: GraphLoader,
  params: {
    readonly targetChannel: string;
    readonly arch: Arch;
    readonly start: Version;
    readonly target: Version;
    readonly anchor?: AnchorSnapshot;
    readonly constraints?: RouteConstraints;
  },
): Promise<Result<StitchedPathResult, StitchError>> {
  const { targetChannel: anchorChannel, arch, start, target } = params;
  const constraints = params.constraints ?? NO_CONSTRAINTS;

  const loaded = await loadAnchorAndBackward(loader, anchorChannel, arch, start, params.anchor?.graph);
  if (!loaded.ok) {
    return loaded;
  }
  const { anchor, backward } = loaded.value;
  const targetInAnchor = versionsOf(anchor.graph).has(target);
  const singleGraph = backward.length === 0 && targetInAnchor;

  let lookahead: readonly ChannelSegment[] = [];
  let lookaheadFailure: LookaheadDiscovery['failure'];
  if (!targetInAnchor) {
    const discovery = params.anchor?.lookahead ?? (await discoverLookahead(loader, anchorChannel, anchor.graph, arch));
    lookaheadFailure = discovery.failure;
    if (!discovery.segments.some((segment) => versionsOf(segment.graph).has(target))) {
      return err(
        lookaheadFailure
          ? { kind: 'loadFailed', ...lookaheadFailure }
          : { kind: 'targetNeverFound', target, channelsTried: discovery.channelsTried },
      );
    }
    lookahead = discovery.segments;
  }

  const model = buildRoutingModel([...backward, anchor, ...lookahead]);
  const found = findRoute(model, start, target, constraints);
  if (!found.ok) {
    if (found.error.kind === 'stopUnreachable') return err(found.error);
    // The single-graph engine names why no path exists (plan.md §4).
    if (singleGraph) {
      const reason = findPathsInGraph(anchor.graph, start, target);
      if (!reason.ok) return err(reason.error);
    }
    // Start and target are each present but no shared version joins them,
    // unless the channel that failed to load would have.
    // No cross-graph `nearestReachable`: the single-graph path computes one
    // per plan.md §4, and multi-graph stitching does not attempt it.
    return err(lookaheadFailure ? { kind: 'loadFailed', ...lookaheadFailure } : { kind: 'unreachable', start, target });
  }
  const route = found.value;
  const comparison = constraints.riskPolicy === 'recommended' ? lowerRiskRoute(model, start, target, constraints, route) : undefined;
  const toPath = (r: Route): Path => ({
    versions: [start, ...r.hops.map((h) => h.to)],
    hops: r.hops,
    cost: r.cost,
    riskSummary: dedupeRisks(r.hops.map((h) => h.risks)),
  });
  const riskComparison = comparison && { route: comparison.route && toPath(comparison.route), conditionalFree: comparison.conditionalFree };

  if (singleGraph) {
    const primary = toPath(route);
    // Waypoint alternates ignore stops and rank by the recommended order, so
    // they are offered only when neither applies.
    const unconstrained = constraints.stops.length === 0 && constraints.riskPolicy === 'recommended';
    const single = unconstrained ? findPathsInGraph(anchor.graph, start, target, primary.versions) : undefined;
    const alternates = single?.ok
      ? single.value.alternates.map((p) => ({ ...p, hops: p.hops.map((h) => ({ ...h, sourceChannel: anchor.channel })) }))
      : [];
    return ok({
      primary,
      riskComparison,
      alternates,
      stitch: { channelsUsed: [anchor.channel], classFallbacks: [], multiGraph: false },
      stations: routeStations([anchor], start, route.hops),
    });
  }

  const primaryChannels = new Set(route.hops.map((h) => h.sourceChannel));
  const usedLookahead = lookahead.filter((segment) => primaryChannels.has(segment.channel));
  const anchorSideFirst = [...backward].reverse();

  return ok({
    primary: toPath(route),
    riskComparison,
    // Multi-graph alternates are out of scope: computing them soundly would
    // mean repeating the layered DP once per candidate waypoint per segment,
    // and the trick that makes single-graph alternates cheap doesn't hold
    // across a channel boundary.
    alternates: [],
    stitch: {
      channelsUsed: [anchor.channel, ...anchorSideFirst.map((s) => s.channel), ...usedLookahead.map((s) => s.channel)],
      classFallbacks: usedLookahead.flatMap((segment) =>
        segment.classFallback ? [{ channel: segment.channel, requestedClass: segment.requestedClass, requestedStatus: segment.requestedStatus }] : [],
      ),
      multiGraph: true,
    },
    stations: routeStations([...backward, anchor, ...lookahead], start, route.hops),
  });
}

/**
 * The best route honoring `constraints`, or why there is none. A stop that
 * is the start or target, or that no route through the earlier stops
 * reaches, is named; when every stop is reached but the target is not from
 * the last, the last stop is named. A target unreachable even without stops
 * is `unreachable`.
 */
function findRoute(
  model: RoutingModel,
  start: Version,
  target: Version,
  constraints: RouteConstraints,
): Result<Route, Extract<StitchError, { kind: 'stopUnreachable' }> | { readonly kind: 'unreachable' }> {
  const { stops } = constraints;
  const misplaced = stops.findIndex((stop) => stop === start || stop === target);
  const layers = misplaced < 0 ? searchRoutes(model, start, constraints) : [];
  const route = layers.at(-1)?.get(target);
  if (route) return ok(route);
  if (stops.length === 0 || !searchRoutes(model, start, { ...constraints, stops: [] })[0]?.has(target)) {
    return err({ kind: 'unreachable' });
  }
  let index = misplaced;
  if (index < 0) index = stops.findIndex((stop, i) => !layers[i + 1]?.has(stop));
  if (index < 0) index = stops.length - 1;
  return err({ kind: 'stopUnreachable', index, stop: stops[index] as Version });
}

/**
 * The `avoidConditional` route under the same stops, when it carries fewer
 * risk occurrences than `primary` (fewer `Always`, or as many and fewer
 * conditional). Posture ranks first under both policies, so it never trades
 * the anchor's class for less risk.
 */
function lowerRiskRoute(
  model: RoutingModel,
  start: Version,
  target: Version,
  constraints: RouteConstraints,
  primary: Route,
): { readonly route: Route | undefined; readonly conditionalFree: boolean } {
  const avoiding = searchRoutes(model, start, { ...constraints, riskPolicy: 'avoidConditional' }).at(-1)?.get(target) as Route;
  const lower = avoiding.always - primary.always || avoiding.conditional - primary.conditional;
  const route = lower < 0 ? avoiding : undefined;
  return { route, conditionalFree: (route ?? primary).conditional === 0 };
}
