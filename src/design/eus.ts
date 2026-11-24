import type { PathHop } from '../engine/types';
import { formatStream, type Stream, streamOf } from '../engine/version';
import type { GraphError } from '../graph/errors';
import type { Graph, Version } from '../graph/types';
import { formatChannelName, parseChannelName } from './channels';

/**
 * The first minor with an EUS channel. Verified against the live API: `eus-4.1`
 * through `eus-4.5` all return an empty graph, while `eus-4.6` has 52 nodes.
 * Parity alone is NOT sufficient -- 4.2 and 4.4 are even but predate EUS
 * entirely, and without this floor the advisory misfires on a 4.4 -> 4.6 plan.
 */
const FIRST_EUS_MINOR = 6;

/**
 * EUS minors are even-numbered AND at or above 4.6 (plan.md §6 "The EUS
 * advisory"). Verified exhaustively against the live graph API across 4.1-4.23:
 * every even minor from 4.6 to 4.22 has a populated `eus-4.N` channel, every
 * odd minor returns zero nodes, and every even minor below 4.6 returns zero
 * nodes.
 */
export function isEusMinor(minor: number): boolean {
  return minor % 2 === 0 && minor >= FIRST_EUS_MINOR;
}

// Verbatim from Red Hat's "Performing a Control Plane Only update using the CLI".
export const PAUSE_WORKERS_COMMAND = `oc patch mcp/worker --type merge --patch '{"spec":{"paused":true}}'`;
export const UNPAUSE_WORKERS_COMMAND = `oc patch mcp/worker --type merge --patch '{"spec":{"paused":false}}'`;

/**
 * Red Hat offers a Control Plane Only update "only after updates between all
 * versions involved have been made available in `stable` channels". A hop the
 * planner took from a fast or candidate graph may not be in stable yet.
 */
const CONTROL_PLANE_ONLY_CLASSES: ReadonlySet<string> = new Set(['eus', 'stable']);

function isStableOrEusHop(hop: PathHop): boolean {
  const cls = hop.sourceChannel === undefined ? undefined : parseChannelName(hop.sourceChannel)?.cls;
  return cls !== undefined && CONTROL_PLANE_ONLY_CLASSES.has(cls);
}

/** One EUS channel's graph as the caller has it so far. */
export type EusGraphState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'loaded'; readonly graph: Graph }
  | { readonly kind: 'failed'; readonly error: GraphError };

export type EusGraphLookup = (channel: string) => EusGraphState;

const publishedEdgeCache = new WeakMap<Graph, ReadonlySet<string>>();

function publishes(graph: Graph, hop: PathHop): boolean {
  let edges = publishedEdgeCache.get(graph);
  if (!edges) {
    edges = new Set(graph.edges.map(([from, to]) => `${graph.nodes[from]?.version}>${graph.nodes[to]?.version}`));
    publishedEdgeCache.set(graph, edges);
  }
  return edges.has(`${hop.from}>${hop.to}`);
}

/**
 * One Control Plane Only (formerly EUS-to-EUS) span of the route: 4.E ->
 * 4.E+1 -> 4.E+2, which Red Hat lets you take with worker pools paused, so
 * workers reboot once for two minors. The procedure covers exactly one such
 * span, and a cluster with paused pools is not permitted to update to any
 * further minor, so a longer route is a chain of legs with workers unpaused
 * and caught up between them (plan.md §6).
 */
interface LegSpan {
  readonly from: Stream;
  readonly via: Stream;
  readonly to: Stream;
  /**
   * `eus-4.(E+2)`. Red Hat's CLI procedure switches the cluster to it before
   * pausing workers, so the paused hops run on it: the leg is judged against
   * this channel's own graph, never against the channel the route took.
   */
  readonly eusChannel: string;
  readonly docsUrl: string;
}

/** `eusChannel`'s graph publishes every hop run with workers paused, and none came from fast or candidate. */
export interface AvailableLeg extends LegSpan {
  readonly kind: 'available';
  /** Last route version in `from`: switch to `eusChannel` and pause here, right before the hop into `via`. */
  readonly pauseAt: Version;
  /** First route version in `via`, the first hop taken with workers paused. */
  readonly firstPausedHopTo: Version;
  /** Last version reached with workers paused: the first arrival in `to`, or a later `to` patch `eusChannel` also publishes. */
  readonly unpauseAt: Version;
  /** Indexes into the route's hops of the first and last hop run with workers paused, all on `eusChannel`. */
  readonly pausedHops: { readonly first: number; readonly last: number };
}

/** `eusChannel`'s graph is still loading. */
export interface CheckingLeg extends LegSpan {
  readonly kind: 'checking';
}

export type UnavailableReason =
  /** A hop run with workers paused came from a fast or candidate graph, or from no recorded one. */
  | { readonly kind: 'notStable'; readonly hop: PathHop }
  /** `eusChannel`'s graph does not publish this hop run with workers paused. */
  | { readonly kind: 'notOnEus'; readonly hop: PathHop }
  /** `eusChannel` failed to load, or has no releases (`empty`). */
  | { readonly kind: 'eusNotLoaded'; readonly error: GraphError };

/** No pause steps: Red Hat does not offer, or the planner could not confirm, a Control Plane Only update over this span. */
export interface UnavailableLeg extends LegSpan {
  readonly kind: 'unavailable';
  readonly reason: UnavailableReason;
}

export type ControlPlaneOnlyLeg = AvailableLeg | CheckingLeg | UnavailableLeg;

interface StreamRun {
  readonly stream: Stream;
  /** Indexes of the run's first and last versions in the route's versions; hop `i` arrives at version `i + 1`. */
  readonly firstIndex: number;
  readonly lastIndex: number;
}

function streamRuns(versions: readonly Version[]): StreamRun[] {
  const runs: StreamRun[] = [];
  versions.forEach((version, index) => {
    const stream = streamOf(version);
    const prev = runs.at(-1);
    if (prev && formatStream(prev.stream) === formatStream(stream)) {
      runs[runs.length - 1] = { ...prev, lastIndex: index };
    } else {
      runs.push({ stream, firstIndex: index, lastIndex: index });
    }
  });
  return runs;
}

// EUS is only known for 4.x; a later major's rules are not something to guess.
function isLegStart(a: StreamRun, b: StreamRun, c: StreamRun): boolean {
  const { major, minor } = a.stream;
  return (
    major === 4 &&
    isEusMinor(minor) &&
    b.stream.major === major &&
    b.stream.minor === minor + 1 &&
    c.stream.major === major &&
    c.stream.minor === minor + 2
  );
}

/** A leg's span located on the route's hops. */
interface SpanOnRoute {
  readonly span: LegSpan;
  /** Hops `[pauseHop, arrivalHop]` run with workers paused: from the pause point to the first arrival in `to`. */
  readonly pauseHop: number;
  readonly arrivalHop: number;
  /** Hops after `arrivalHop` up to this one stay inside `to`, so workers may stay paused over them. */
  readonly lastHopInDestination: number;
}

/** Consecutive legs share their EUS stream: one leg's unpause point is the next leg's pause point. */
function spansOnRoute(hops: readonly PathHop[]): SpanOnRoute[] {
  const first = hops[0];
  const runs = streamRuns(first ? [first.from, ...hops.map((hop) => hop.to)] : []);
  const spans: SpanOnRoute[] = [];
  let i = 0;
  while (i + 2 < runs.length) {
    const [a, b, c] = [runs[i], runs[i + 1], runs[i + 2]] as [StreamRun, StreamRun, StreamRun];
    if (!isLegStart(a, b, c)) {
      i += 1;
      continue;
    }
    spans.push({
      span: {
        from: a.stream,
        via: b.stream,
        to: c.stream,
        eusChannel: formatChannelName({ cls: 'eus', ...c.stream }),
        docsUrl: `https://docs.redhat.com/en/documentation/openshift_container_platform/${formatStream(c.stream)}/html/updating_clusters/performing-a-cluster-update#control-plane-only-update`,
      },
      pauseHop: a.lastIndex,
      arrivalHop: c.firstIndex - 1,
      lastHopInDestination: c.lastIndex - 1,
    });
    i += 2;
  }
  return spans;
}

function requiredPausedHops(hops: readonly PathHop[], { pauseHop, arrivalHop }: SpanOnRoute): readonly PathHop[] {
  return hops.slice(pauseHop, arrivalHop + 1);
}

/** The EUS channels whose graphs `controlPlaneOnlyLegs` needs for this route: one per leg no fast or candidate hop rules out. */
export function eusChannelsToCheck(hops: readonly PathHop[]): readonly string[] {
  return spansOnRoute(hops)
    .filter((located) => requiredPausedHops(hops, located).every(isStableOrEusHop))
    .map((located) => located.span.eusChannel);
}

function judgeLeg(hops: readonly PathHop[], located: SpanOnRoute, eusGraph: EusGraphLookup): ControlPlaneOnlyLeg {
  const { span, pauseHop, arrivalHop, lastHopInDestination } = located;
  const required = requiredPausedHops(hops, located);
  const notStable = required.find((hop) => !isStableOrEusHop(hop));
  if (notStable) return { ...span, kind: 'unavailable', reason: { kind: 'notStable', hop: notStable } };

  const eus = eusGraph(span.eusChannel);
  if (eus.kind === 'loading') return { ...span, kind: 'checking' };
  if (eus.kind === 'failed') return { ...span, kind: 'unavailable', reason: { kind: 'eusNotLoaded', error: eus.error } };
  const notOnEus = required.find((hop) => !publishes(eus.graph, hop));
  if (notOnEus) return { ...span, kind: 'unavailable', reason: { kind: 'notOnEus', hop: notOnEus } };

  // Patch hops inside the destination may run unpaused as ordinary updates, so they only decide how long the pause can last.
  let last = arrivalHop;
  while (last < lastHopInDestination) {
    const next = hops[last + 1] as PathHop;
    if (!isStableOrEusHop(next) || !publishes(eus.graph, next)) break;
    last += 1;
  }
  const pausePoint = hops[pauseHop] as PathHop;
  return {
    ...span,
    kind: 'available',
    pauseAt: pausePoint.from,
    firstPausedHopTo: pausePoint.to,
    unpauseAt: (hops[last] as PathHop).to,
    pausedHops: { first: pauseHop, last },
  };
}

/**
 * The Control Plane Only legs of an actual route (`Path.hops`, after stops
 * and avoids), in order. Cincinnati does not encode this; it is UI-side
 * guidance (EusAdvisory.tsx), judged against each leg's `eus-4.(E+2)` graph
 * as `eusGraph` has it so far.
 */
export function controlPlaneOnlyLegs(hops: readonly PathHop[], eusGraph: EusGraphLookup): readonly ControlPlaneOnlyLeg[] {
  return spansOnRoute(hops).map((located) => judgeLeg(hops, located, eusGraph));
}

/**
 * A point in the leg's hop sequence and the commands to run there, in order.
 * Each point is copied on its own: the points are separated by updates, so a
 * paste holding two of them would run the second before those updates happen.
 */
export interface LegCheckpoint {
  readonly kind: 'pause' | 'unpause' | 'waitForPools';
  readonly when: string;
  readonly commands: readonly string[];
}

/** The order of Red Hat's "Control Plane Only update using the CLI": pools settled, switch to eus-4.(E+2), pause, update, unpause, check pools. */
export function legCheckpoints(leg: AvailableLeg): readonly LegCheckpoint[] {
  return [
    {
      kind: 'pause',
      when:
        `At ${leg.pauseAt}, before oc adm upgrade --to ${leg.firstPausedHopTo}. First confirm with oc get mcp that every pool reports ` +
        `UPDATED=True and UPDATING=False. Then switch to ${leg.eusChannel} and pause workers: the updates through ${leg.unpauseAt} run on ${leg.eusChannel}.`,
      commands: [`oc adm upgrade channel ${leg.eusChannel}`, PAUSE_WORKERS_COMMAND],
    },
    { kind: 'unpause', when: `Once the cluster reports ${leg.unpauseAt}`, commands: [UNPAUSE_WORKERS_COMMAND] },
    {
      kind: 'waitForPools',
      when: `Before the next update of any kind, including a patch update within ${formatStream(leg.to)}, wait until every pool you paused reports UPDATED=True and UPDATING=False`,
      commands: ['oc get mcp'],
    },
  ];
}
