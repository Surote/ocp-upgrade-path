import { formatChannelName, parseChannelName } from '../design/channels';
import type { Arch, Graph, GraphNode, Version } from '../graph/types';
import { err, ok, type Result } from '../lib/result';
import { type ChannelSegment, discoverLookahead, type LookaheadDiscovery } from './lookahead';
import { findPathsInGraph } from './pathfinder';
import { routeAcrossSegments } from './routeSearch';
import { dedupeRisks } from './risks';
import { compareStreams, type Stream, streamOf } from './version';
import type { GraphLoader, Path, StitchError, StitchedPathResult } from './types';

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
 * Node *metadata* (payload, errataUrl, channel membership) is different from
 * edges: the same version can legitimately have slightly different metadata
 * across two channel snapshots, so `nodeInfo` on the result merges metadata
 * across every fetched graph with "later channel wins" -- the channel closer
 * to the target end of the composed chain takes priority on a conflict,
 * exactly the plan's stated rule -- applied only to that read-only lookup
 * table, never to traversal.
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

/** "Later channel wins": earlier entries in `priorityOrder` (closer to the target end of the composed chain) take precedence. */
function buildNodeInfo(priorityOrder: readonly ChannelSegment[]): ReadonlyMap<Version, GraphNode> {
  const map = new Map<Version, GraphNode>();
  for (const segment of priorityOrder) {
    for (const node of segment.graph.nodes) {
      if (!map.has(node.version)) {
        map.set(node.version, node);
      }
    }
  }
  return map;
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
 */
export async function stitchAndFindPath(
  loader: GraphLoader,
  params: {
    readonly targetChannel: string;
    readonly arch: Arch;
    readonly start: Version;
    readonly target: Version;
    readonly anchor?: AnchorSnapshot;
  },
): Promise<Result<StitchedPathResult, StitchError>> {
  const { targetChannel: anchorChannel, arch, start, target } = params;

  const loaded = await loadAnchorAndBackward(loader, anchorChannel, arch, start, params.anchor?.graph);
  if (!loaded.ok) {
    return loaded;
  }
  const { anchor, backward } = loaded.value;
  const targetInAnchor = versionsOf(anchor.graph).has(target);

  if (backward.length === 0 && targetInAnchor) {
    // Fast path (also the common case -- every worked example in plan.md
    // resolves within a single graph): full alternates support.
    const singleGraphResult = findPathsInGraph(anchor.graph, start, target);
    if (!singleGraphResult.ok) {
      return err(singleGraphResult.error);
    }
    const withProvenance = (p: Path): Path => ({
      ...p,
      hops: p.hops.map((h) => ({ ...h, sourceChannel: anchor.channel })),
    });
    return ok({
      primary: withProvenance(singleGraphResult.value.primary),
      alternates: singleGraphResult.value.alternates.map(withProvenance),
      stitch: { channelsUsed: [anchor.channel], classFallbacks: [], multiGraph: false },
      nodeInfo: buildNodeInfo([anchor]),
    });
  }

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

  const chain = [...backward, anchor, ...lookahead];
  const route = routeAcrossSegments(chain, start).get(target);
  if (!route) {
    // Start and target are each present but no shared version joins them,
    // unless the channel that failed to load would have.
    // No cross-graph `nearestReachable`: the single-graph path computes one
    // per plan.md §4, and multi-graph stitching does not attempt it.
    return err(lookaheadFailure ? { kind: 'loadFailed', ...lookaheadFailure } : { kind: 'unreachable', start, target });
  }

  const routedChannels = new Set(route.hops.map((h) => h.sourceChannel));
  const usedLookahead = lookahead.filter((segment) => routedChannels.has(segment.channel));
  const anchorSideFirst = [...backward].reverse();
  const versions = [start, ...route.hops.map((h) => h.to)];
  const { hops } = route;

  return ok({
    primary: { versions, hops, cost: route.cost, riskSummary: dedupeRisks(hops.map((h) => h.risks)) },
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
    nodeInfo: buildNodeInfo([...usedLookahead].reverse().concat(anchor, anchorSideFirst)),
  });
}
