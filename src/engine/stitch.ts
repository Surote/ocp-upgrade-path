import { candidateChannelsForMinor } from '../design/forwardChannel';
import { channelClassOf } from '../design/channels';
import type { Arch, Graph, GraphNode, Version } from '../graph/types';
import { err, ok, type Result } from '../lib/result';
import { findPathsInGraph } from './pathfinder';
import { dedupeRisks } from './risks';
import { parseVersion } from './version';
import type { ClassFallback, GraphLoader, Path, PathCost, PathHop, StitchError, StitchedPathResult } from './types';

/**
 * Stitching, per plan.md §4 and §6 "Look-ahead targets (bidirectional
 * stitching)". The selected channel is an **anchor**: the graph the cluster
 * is actually on right now. It is fetched first; the stitcher then walks
 * **backward** (to strictly older-minor channels of the same prefix) when the
 * anchor doesn't contain `start`, and **forward** (to higher-minor channels,
 * same class preferred, `stable` fallback) when it doesn't contain `target`.
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

const CHANNEL_PATTERN = /^(.+)-4\.(\d+)$/;
const MAX_WALK_BACK = 12; // safety bound: no real Cincinnati channel history is this deep
const MAX_WALK_FORWARD = 12; // mirrors MAX_WALK_BACK -- no real Cincinnati channel future is this deep either

interface LoadedSegment {
  readonly channel: string;
  readonly graph: Graph;
  /** Set when this segment was loaded via the `stable` fallback rather than the anchor's own class (plan.md §6 "Forward channel preference"). */
  readonly classFallback?: { readonly requestedClass: string };
}

function versionsOf(graph: Graph): ReadonlySet<Version> {
  return new Set(graph.nodes.map((n) => n.version));
}

function intersects(a: ReadonlySet<Version>, b: ReadonlySet<Version>): boolean {
  for (const v of a) {
    if (b.has(v)) return true;
  }
  return false;
}

/** "Later channel wins": earlier entries in `priorityOrder` (closer to the target end of the composed chain) take precedence. */
function buildNodeInfo(priorityOrder: readonly LoadedSegment[]): ReadonlyMap<Version, GraphNode> {
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

interface BidirectionalLoadResult {
  /** Start-to-target order, ready for `stitchPrimaryAcrossSegments`. */
  readonly orderedStartToTarget: readonly LoadedSegment[];
  /** Fetch order (anchor first, then backward segments, then forward segments) -- for the audit banner. */
  readonly channelsUsed: readonly string[];
  /** Target-end-first priority order, for "later channel wins" node-info merging. */
  readonly nodeInfoPriority: readonly LoadedSegment[];
  readonly classFallbacks: readonly ClassFallback[];
}

/**
 * Fetches the anchor channel, then -- as needed -- walks backward to cover
 * `start` and/or forward to cover `target`. Per plan.md §6, the anchor is
 * fetched exactly once regardless of which (or both) walks fire.
 */
async function loadSegmentsBidirectional(
  loader: GraphLoader,
  anchorChannel: string,
  arch: Arch,
  start: Version,
  target: Version,
): Promise<Result<BidirectionalLoadResult, StitchError>> {
  const match = CHANNEL_PATTERN.exec(anchorChannel);
  if (!match) {
    return err({ kind: 'invalidChannel', channel: anchorChannel });
  }
  const [, rawPrefix, minorStr] = match;
  const prefix = rawPrefix as string; // capture group 1 of `(.+)` -- always present when `match` succeeded
  const anchorMinor = Number(minorStr);

  const anchorLoaded = await loader(anchorChannel, arch);
  if (!anchorLoaded.ok) {
    return err({ kind: 'loadFailed', channel: anchorChannel, error: anchorLoaded.error });
  }
  const anchorSegment: LoadedSegment = { channel: anchorChannel, graph: anchorLoaded.value };
  const anchorVersions = versionsOf(anchorSegment.graph);

  const hasStart = anchorVersions.has(start);
  const hasTarget = anchorVersions.has(target);

  // --- Backward walk: unchanged shape/bound from the original single-direction stitcher, minus the now-shared anchor fetch. ---
  const backSegments: LoadedSegment[] = []; // anchor-adjacent-first ... start-containing-last
  if (!hasStart) {
    const channelsTried = [anchorChannel];
    let minor = anchorMinor - 1;
    let found = false;
    for (let step = 0; step < MAX_WALK_BACK && minor >= 0; step += 1) {
      const channel = `${prefix}-4.${minor}`;
      channelsTried.push(channel);
      const loaded = await loader(channel, arch);
      if (!loaded.ok) {
        return err({ kind: 'loadFailed', channel, error: loaded.error });
      }
      const segment: LoadedSegment = { channel, graph: loaded.value };
      backSegments.push(segment);
      if (versionsOf(segment.graph).has(start)) {
        found = true;
        break;
      }
      minor -= 1;
    }
    if (!found) {
      return err({ kind: 'startNeverFound', start, channelsTried });
    }
  }

  // --- Forward walk (new, plan.md §6): starts at the *target's own* minor --
  // not one minor past the anchor -- so a channel that already reaches back
  // far enough (e.g. `eus-4.22` sharing 32 releases with `eus-4.20`) joins
  // directly, with no unnecessary intermediate channel. Only steps down
  // toward the anchor when the first candidate doesn't yet overlap it. ---
  const forwardSegments: LoadedSegment[] = []; // target-adjacent-first ... anchor-adjacent-last
  const classFallbacks: ClassFallback[] = [];
  if (!hasTarget) {
    const preferredClass = channelClassOf(anchorChannel) ?? prefix;
    const channelsTried: string[] = [];
    let minor = parseVersion(target).minor;
    let joined = false;

    for (let step = 0; step < MAX_WALK_FORWARD && minor > anchorMinor; step += 1) {
      const candidates = candidateChannelsForMinor(preferredClass, minor);
      let segment: LoadedSegment | undefined;

      for (let ci = 0; ci < candidates.length; ci += 1) {
        const candidateChannel = candidates[ci] as string;
        channelsTried.push(candidateChannel);
        const loaded = await loader(candidateChannel, arch);
        if (loaded.ok) {
          segment = {
            channel: candidateChannel,
            graph: loaded.value,
            classFallback: ci > 0 ? { requestedClass: preferredClass } : undefined,
          };
          break;
        }
        // 'empty' = Cincinnati's "channel doesn't exist" signal (HTTP 200,
        // empty arrays, surfaced by parseRawGraph as `empty`) -- try the next
        // candidate / minor. Any other error kind is a genuine transport or
        // validation failure worth surfacing immediately, not swallowing.
        if (loaded.error.kind !== 'empty') {
          return err({ kind: 'loadFailed', channel: candidateChannel, error: loaded.error });
        }
      }

      if (!segment) break; // neither the preferred class nor `stable` exists at this minor -- nothing further to try
      forwardSegments.push(segment);
      if (segment.classFallback) {
        classFallbacks.push({ channel: segment.channel, requestedClass: segment.classFallback.requestedClass });
      }

      if (intersects(versionsOf(segment.graph), anchorVersions)) {
        joined = true;
        break;
      }
      minor -= 1;
    }

    if (!joined) {
      return err({ kind: 'targetNeverFound', target, channelsTried });
    }
  }

  const orderedStartToTarget = [...backSegments].reverse().concat(anchorSegment, [...forwardSegments].reverse());
  const channelsUsed = [anchorSegment.channel, ...backSegments.map((s) => s.channel), ...forwardSegments.map((s) => s.channel)];
  const nodeInfoPriority = [...forwardSegments, anchorSegment, ...backSegments];

  return ok({ orderedStartToTarget, channelsUsed, nodeInfoPriority, classFallbacks });
}

// --- Multi-graph primary-only pathfinding (see module doc: never union edges) ---

interface FrontierEntry {
  readonly cost: PathCost;
  readonly hops: readonly PathHop[];
}

function combineCost(a: PathCost, b: PathCost): PathCost {
  return { hops: a.hops + b.hops, riskWeight: a.riskWeight + b.riskWeight, tieBreak: a.tieBreak + b.tieBreak };
}

function costLess(a: PathCost, b: PathCost): boolean {
  if (a.hops !== b.hops) return a.hops < b.hops;
  if (a.riskWeight !== b.riskWeight) return a.riskWeight < b.riskWeight;
  return a.tieBreak < b.tieBreak;
}

/**
 * Chains per-segment shortest paths from `start` through to `target` across
 * `segments` (ordered start-side to target-side), never mixing edges from two
 * segments in one traversal step. At each stage, the frontier of
 * already-reached junction versions is advanced by running a fresh
 * single-graph search (`findPathsInGraph`, which already restricts itself to
 * one graph's own edges) from every frontier version into the *next*
 * segment, keeping only the cheapest route to each candidate junction. This
 * is a standard layered shortest-path DP: because cost only ever accumulates
 * (never decreases) and each stage keeps the pointwise minimum per junction,
 * the frontier at the final stage holds the true minimum-cost route to
 * `target` given the fixed segment order -- without ever needing a merged
 * edge set.
 *
 * Every hop produced here is tagged with `sourceChannel: segment.channel` --
 * the segment whose own edges were walked to produce it. This DP-assigned
 * boundary is a valid *candidate* switch point (the station it lands on is,
 * by construction, a member of both the outgoing and incoming segment -- see
 * `findPathsInGraph`'s node-membership requirement) but it optimises for
 * path *cost*, not for early attribution: when several consecutive stations
 * all belong to the destination channel, cost (or edge availability -- see
 * `reattributeEarliestSwitch` below) can legitimately leave the DP boundary
 * later than the earliest one. `reattributeEarliestSwitch` corrects this
 * before the path is returned, per plan.md §6 "Where the switch is
 * attributed matters".
 */
function stitchPrimaryAcrossSegments(
  segments: readonly LoadedSegment[],
  start: Version,
  target: Version,
): Path | undefined {
  let frontier = new Map<Version, FrontierEntry>([[start, { cost: { hops: 0, riskWeight: 0, tieBreak: 0 }, hops: [] }]]);

  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i] as LoadedSegment;
    const isLastSegment = i === segments.length - 1;
    const nextSegment = segments[i + 1];
    const nextVersions: ReadonlySet<Version> = isLastSegment
      ? new Set([target])
      : versionsOf((nextSegment as LoadedSegment).graph);

    const nextFrontier = new Map<Version, FrontierEntry>();

    for (const [fromVersion, state] of frontier) {
      if (!segment.graph.nodes.some((n) => n.version === fromVersion)) continue;

      for (const candidateVersion of nextVersions) {
        const localResult = findPathsInGraph(segment.graph, fromVersion, candidateVersion);
        if (!localResult.ok) continue;

        const localHops = localResult.value.primary.hops.map((h) => ({ ...h, sourceChannel: segment.channel }));
        const combinedCost = combineCost(state.cost, localResult.value.primary.cost);
        const combinedHops = [...state.hops, ...localHops];
        const existing = nextFrontier.get(candidateVersion);
        if (!existing || costLess(combinedCost, existing.cost)) {
          nextFrontier.set(candidateVersion, { cost: combinedCost, hops: combinedHops });
        }
      }
    }

    frontier = nextFrontier;
    if (frontier.size === 0) return undefined;
  }

  const finalState = frontier.get(target);
  if (!finalState) return undefined;

  const versions: Version[] = [start];
  for (const hop of finalState.hops) versions.push(hop.to);

  const hops = reattributeEarliestSwitch(versions, finalState.hops, segments);

  return {
    versions,
    hops,
    cost: finalState.cost,
    riskSummary: dedupeRisks(hops.map((h) => h.risks)),
  };
}

/**
 * Re-attributes each hop's `sourceChannel` to the *earliest* station on the
 * path that is genuinely a member of the channel about to be used -- plan.md
 * §6 "Where the switch is attributed matters": the `oc adm upgrade channel`
 * command runs while the cluster is standing on a release, so it belongs to
 * the earliest point the destination channel becomes available, not
 * wherever `stitchPrimaryAcrossSegments`'s layered DP happened to land its
 * boundary (which optimises for path cost/edge availability, not early
 * attribution -- see that function's doc).
 *
 * Applied independently per crossing, per plan.md §6 ("Where a path crosses
 * more than two channels, apply the same rule independently to each
 * crossing"): each transition between two distinct consecutive
 * `sourceChannel` values is handled on its own, scanning only the stations
 * visited while the *previous* segment was current for the earliest one
 * that is a real member of the *next* segment's own fetched graph -- a
 * direct node lookup against `segment.graph.nodes` (`versionsOf`), never a
 * constructed channel name and never a guess. If none of those earlier
 * stations qualify, the DP's own boundary is used unchanged (the scan always
 * finds *at least* that one, since it's guaranteed to be a member of the
 * destination segment by construction).
 *
 * Purely a relabelling pass: it never changes which versions are visited,
 * which edges were walked, or the path's cost -- only which fetched channel
 * each hop is attributed to for switch-command purposes.
 */
function reattributeEarliestSwitch(
  versions: readonly Version[],
  hops: readonly PathHop[],
  segments: readonly LoadedSegment[],
): readonly PathHop[] {
  if (segments.length <= 1 || hops.length === 0) return hops;

  const segIndexByChannel = new Map(segments.map((s, idx) => [s.channel, idx] as const));
  const memberSets = segments.map((s) => versionsOf(s.graph));
  const dpSeg = hops.map((h) => (h.sourceChannel ? (segIndexByChannel.get(h.sourceChannel) ?? 0) : 0));

  const effectiveSeg = [...dpSeg];
  let runStartStation = 0; // station index (into `versions`) where the current DP-assigned run began

  for (let i = 0; i < hops.length; i += 1) {
    if (i > 0 && dpSeg[i] !== dpSeg[i - 1]) {
      const destSegIdx = dpSeg[i] as number;
      const destMembers = memberSets[destSegIdx] as ReadonlySet<Version>;

      let earliestStation = i; // fallback: the DP's own junction (this hop's `.from`)
      for (let s = runStartStation; s <= i; s += 1) {
        if (destMembers.has(versions[s] as Version)) {
          earliestStation = s;
          break;
        }
      }
      for (let k = earliestStation; k < i; k += 1) effectiveSeg[k] = destSegIdx;

      runStartStation = i; // the next crossing (if any) scans forward from here
    }
  }

  return hops.map((h, i) => ({ ...h, sourceChannel: segments[effectiveSeg[i] as number]?.channel ?? h.sourceChannel }));
}

/**
 * Finds the recommended (and, when a single graph suffices, alternate) path
 * from `start` to `target`, fetching whichever channel graphs are needed via
 * the injected `loader`. `targetChannel` is the caller's selected channel --
 * per plan.md §6 this is the **anchor** (the channel the cluster is on now),
 * not necessarily the target's own channel: `stitchAndFindPath` walks
 * backward to cover `start` and/or forward to cover `target` as needed.
 */
export async function stitchAndFindPath(
  loader: GraphLoader,
  params: { readonly targetChannel: string; readonly arch: Arch; readonly start: Version; readonly target: Version },
): Promise<Result<StitchedPathResult, StitchError>> {
  const { targetChannel: anchorChannel, arch, start, target } = params;

  const loadResult = await loadSegmentsBidirectional(loader, anchorChannel, arch, start, target);
  if (!loadResult.ok) {
    return loadResult;
  }
  const { orderedStartToTarget, channelsUsed, nodeInfoPriority, classFallbacks } = loadResult.value;
  const nodeInfo = buildNodeInfo(nodeInfoPriority);
  const stitchInfo = { channelsUsed, classFallbacks };

  if (orderedStartToTarget.length === 1) {
    // Fast path (also the common case -- every worked example in plan.md
    // resolves within a single graph): full alternates support.
    const anchorSegment = orderedStartToTarget[0] as LoadedSegment;
    const singleGraphResult = findPathsInGraph(anchorSegment.graph, start, target);
    if (!singleGraphResult.ok) {
      return err(singleGraphResult.error);
    }
    const withProvenance = (p: Path): Path => ({
      ...p,
      hops: p.hops.map((h) => ({ ...h, sourceChannel: anchorSegment.channel })),
    });
    return ok({
      primary: withProvenance(singleGraphResult.value.primary),
      alternates: singleGraphResult.value.alternates.map(withProvenance),
      stitch: { ...stitchInfo, multiGraph: false },
      nodeInfo,
    });
  }

  const primary = stitchPrimaryAcrossSegments(orderedStartToTarget, start, target);

  if (!primary) {
    // A structural reason is more useful than a generic stitch failure when
    // we can tell which one applies; genuine cross-segment unreachability
    // (start and target both individually present, but joined by nothing)
    // is reported as `unreachable` without a cross-graph `nearestReachable`
    // -- computing one would require probing every segment, which the single-
    // graph path already does per plan.md §4 and multi-graph stitching does
    // not attempt (documented scope decision, see engine/stitch.ts doc).
    return err({ kind: 'unreachable', start, target });
  }

  return ok({
    primary,
    // Multi-graph alternates are out of scope for this pass: computing them
    // soundly would mean repeating the layered DP once per candidate
    // waypoint per segment, and no waypoint alternates could safely be
    // reused across a channel boundary edge (the model that makes single-
    // graph alternates cheap doesn't hold once real stitching is involved).
    // Documented, not silently dropped -- see engine/stitch.ts doc and the
    // implementation report.
    alternates: [],
    stitch: { ...stitchInfo, multiGraph: true },
    nodeInfo,
  });
}
