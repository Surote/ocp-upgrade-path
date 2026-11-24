import type { Arch, Graph, GraphNode, Risk, Version } from '../graph/types';
import type { GraphError } from '../graph/errors';
import type { Result } from '../lib/result';

/**
 * The lexicographic cost tuple from plan.md §4:
 *
 *   cost(edge) = ( 1,                          // hop count   -- minimise first
 *                  2·|Always| + 1·|PromQL|,     // risk weight -- then this
 *                  -z )                         // patch level -- tie-break high
 *
 * Summed componentwise across a path, compared lexicographically. `tieBreak`
 * holds the running sum of `-patch(to)` for every edge taken -- see
 * pathfinder.ts for why summing a component that can go negative is still
 * sound for Dijkstra here (it is, and the literal spec is implemented as-is,
 * no workaround needed).
 */
export interface PathCost {
  readonly hops: number;
  readonly riskWeight: number;
  readonly tieBreak: number;
}

export interface PathHop {
  readonly from: Version;
  readonly to: Version;
  readonly risks: readonly Risk[];
  /**
   * Which channel's fetched graph produced this hop -- plan.md §6 "Look-ahead
   * targets (bidirectional stitching)": "`PathHop` must carry its source
   * segment for this feature to be correct." Set by the stitcher
   * (engine/stitch.ts) on every hop it returns, single-graph or multi-graph
   * alike, since the stitcher always knows which segment/channel produced
   * each hop. `undefined` only for a `Path` built directly by the pure
   * single-graph engine (engine/pathfinder.ts) without going through the
   * stitcher -- that function has no channel name to attach and stays pure
   * (no network/channel concept at all).
   *
   * This is what finally makes a channel-switch command attributable to the
   * *correct* hop on a genuine multi-graph stitch: comparing consecutive
   * hops' `sourceChannel` directly names the real, already-fetched channel a
   * switch must land on, without needing to resolve `GraphNode.channels`
   * against a per-graph name table that a multi-graph result can't safely
   * share (design/channels.ts) -- see design/commands.ts.
   *
   * Always the segment whose graph supplied this hop's edge, the same graph
   * `risks` was read from. Never relabelled: once the cluster is on a
   * channel, `oc adm upgrade --to` takes that channel's edge with that
   * channel's risks, and another channel publishing the same edge may attach
   * different ones.
   */
  readonly sourceChannel?: string;
}

export interface Path {
  /** Every version visited, start to target inclusive, in traversal order. */
  readonly versions: readonly Version[];
  readonly hops: readonly PathHop[];
  readonly cost: PathCost;
  /** Deduplicated, Always-first risk summary for the whole path -- plan.md §5. */
  readonly riskSummary: readonly Risk[];
}

export interface FindPathSuccess {
  readonly primary: Path;
  /** Best path per distinct intermediate-minor waypoint, excluding the primary's own waypoint. Capped at 2. */
  readonly alternates: readonly Path[];
}

/**
 * Per plan.md §4, exactly three reasons a path search can fail to produce a
 * usable path:
 *  - the start version isn't a node in the graph at all
 *  - the target is chronologically older than the start (semver-wise) -- a
 *    downgrade, which Cincinnati's edges never encode, named as its own
 *    reason rather than folded into "unreachable" because it explains *why*
 *    up front instead of leaving the operator to guess
 *  - the target is unreachable from the start for any other reason (includes
 *    the degenerate case where the target isn't a node in the graph at all)
 */
export type NoPathReason =
  | Readonly<{ kind: 'startNotFound'; start: Version }>
  | Readonly<{ kind: 'targetOlder'; start: Version; target: Version }>
  | Readonly<{
      kind: 'unreachable';
      start: Version;
      target: Version;
      /** The closest reachable version to `target`, when one exists -- lets the UI say "you can get as far as X" (plan.md §4). */
      nearestReachable?: Version;
    }>;

// --- Stitching (plan.md §4 / §3 "Channel span is not uniform") -------------

/**
 * Loads one channel's graph, already parsed/validated -- an injection seam so
 * the stitcher (engine/stitch.ts) never touches the network or `GraphClient`
 * directly, staying testable with synthetic graphs. In production this
 * adapts `GraphClient.getGraph`, discarding the `fetchedAt` it also returns
 * (not needed by the pure path-search; the freshness banner is a Phase 4/UI
 * concern that reads `GraphClient` results directly).
 */
export type GraphLoader = (channel: string, arch: Arch) => Promise<Result<Graph, GraphError>>;

/**
 * One channel the stitcher used as a **fallback** rather than the caller's
 * preferred class, per plan.md §6 "Forward channel preference": walking
 * forward, the anchor's own class is tried first at a needed stream (e.g.
 * `eus-4.22` for an `eus-4.20` anchor); when that class has no channel there
 * the next of `stable`, `fast`, `candidate` that exists is used instead
 * (design/forwardChannel.ts) -- `eus-4.21` never exists, and 5.0 was at
 * first published only in `candidate-5.0`. A class change alters the
 * operator's support posture, so this must never be a silent detail: the UI
 * reads this list to say so explicitly.
 */
export interface ClassFallback {
  /** The real channel actually used, e.g. `stable-4.21`. */
  readonly channel: string;
  /** The anchor's class, which the route could not stay on at this channel's stream, e.g. `eus`. */
  readonly requestedClass: string;
  /**
   * Why: `unpublished` when Cincinnati returned an empty graph for that
   * class's channel at this stream; `unverified` when fetching it failed, so
   * whether it has a route is unknown; `noRoute` otherwise -- the channel is
   * published, or no release on the way names it, and either way no route
   * on it reaches the target.
   */
  readonly requestedStatus: 'unpublished' | 'unverified' | 'noRoute';
}

/** Which channels the stitcher used, each once in fetch order. The banner's route-order sequence comes from hop provenance (components/routeFacts.ts `channelSequence`). */
export interface StitchInfo {
  readonly channelsUsed: readonly string[];
  /**
   * Every channel in `channelsUsed` that was a same-class fallback rather
   * than the anchor's own preferred class (plan.md §6 "Forward channel
   * preference") -- empty for a purely backward-walked or single-graph
   * result, since backward walking and the single-graph fast path never
   * substitute a different class.
   */
  readonly classFallbacks: readonly ClassFallback[];
}

export interface StitchedPathResult {
  /** The route under the request's `RiskPolicy`, honoring every stop. */
  readonly primary: Path;
  /** Present only under the `recommended` policy: the lower-risk counterpart (engine/routeConstraints.ts). */
  readonly riskComparison?: import('./routeConstraints').RiskComparison;
  /**
   * Waypoint alternates. Only populated when the whole path was found within
   * a single fetched graph (the common case, including every case the
   * verified example and the plan's own worked examples cover) -- see
   * engine/stitch.ts's module doc for why a genuine multi-graph stitch
   * returns the primary only. Never a silent gap: `stitch.multiGraph` says
   * whether this run actually crossed graphs.
   */
  readonly alternates: readonly Path[];
  readonly stitch: StitchInfo & { readonly multiGraph: boolean };
  /**
   * Node info (payload, errataUrl, channel membership) for each station of
   * `primary`, read from the graph that supplied the hop arriving at it (the
   * start from the first hop's graph), so a hop's `--to-image` digest comes
   * from the channel it runs on (plan.md §4). Other routes' stations are absent.
   */
  readonly nodeInfo: ReadonlyMap<Version, GraphNode>;
}

export type StitchError =
  | Readonly<{ kind: 'stopUnreachable'; index: number; stop: Version }>
  | Readonly<{ kind: 'invalidChannel'; channel: string }>
  | Readonly<{ kind: 'loadFailed'; channel: string; error: GraphError }>
  | Readonly<{ kind: 'startNeverFound'; start: Version; channelsTried: readonly string[] }>
  /**
   * The forward-walk analogue of `startNeverFound` (plan.md §6 "Look-ahead
   * targets"): walked forward through `channelsTried` (same class preferred,
   * then the `candidateChannelsForStream` fallbacks per stream) without ever finding a channel whose
   * version set overlaps back with the anchor's own -- i.e. no legitimate
   * join point back to the selected channel was ever found. Distinct from
   * `unreachable` below, which means segments *did* chain together but no
   * edge path connects start to target through them.
   */
  | Readonly<{ kind: 'targetNeverFound'; target: Version; channelsTried: readonly string[] }>
  | NoPathReason;
