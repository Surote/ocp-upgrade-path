import { riskClass, riskIdOf, RiskIndex } from '../engine/risks';
import type { PathHop } from '../engine/types';
import { formatStream, type Stream, streamOf } from '../engine/version';
import type { GraphError } from '../graph/errors';
import type { Graph, GraphNode, Risk, Version } from '../graph/types';
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

/** What a leg reads from its EUS graph: which edges it publishes, the risks it attaches, and its nodes. */
interface EusGraphIndex {
  readonly edges: ReadonlySet<string>;
  readonly risks: RiskIndex;
  readonly nodes: ReadonlyMap<Version, GraphNode>;
}

const indexCache = new WeakMap<Graph, EusGraphIndex>();

function indexOf(graph: Graph): EusGraphIndex {
  let index = indexCache.get(graph);
  if (!index) {
    index = {
      edges: new Set(graph.edges.map(([from, to]) => `${graph.nodes[from]?.version}>${graph.nodes[to]?.version}`)),
      risks: new RiskIndex(graph.conditionalEdges),
      nodes: new Map(graph.nodes.map((node) => [node.version, node])),
    };
    indexCache.set(graph, index);
  }
  return index;
}

function publishes(index: EusGraphIndex, hop: PathHop): boolean {
  return index.edges.has(`${hop.from}>${hop.to}`);
}

/** One update a leg runs with workers paused, as `eusChannel`'s graph publishes it. */
export interface PausedHop {
  readonly from: Version;
  readonly to: Version;
  /** The risks `eusChannel`'s graph attaches to this edge, which can differ from the main route channel's. */
  readonly risks: readonly Risk[];
  /** `eusChannel`'s release image for `to`, for `--to-image`. */
  readonly payload: string;
  /** The same update as the main route takes it, on the channel that supplied it there. */
  readonly onRoute: PathHop;
}

function pausedHop(index: EusGraphIndex, hop: PathHop): PausedHop {
  return {
    from: hop.from,
    to: hop.to,
    risks: index.risks.risksFor(hop.from, hop.to),
    // An edge `publishes` confirmed names a node of the same graph.
    payload: (index.nodes.get(hop.to) as GraphNode).payload,
    onRoute: hop,
  };
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

/**
 * `eusChannel`'s graph publishes every hop run with workers paused, and none
 * came from fast or candidate. The leg is its own procedure on `eusChannel`:
 * the main route's commands never change because of it (plan.md §6).
 */
export interface AvailableLeg extends LegSpan {
  readonly kind: 'available';
  /** Last route version in `from`: switch to `eusChannel` and pause here, right before the hop into `via`. */
  readonly pauseAt: Version;
  /** Last version reached with workers paused: the first arrival in `to`, or a later `to` patch `eusChannel` also publishes. */
  readonly unpauseAt: Version;
  /** The updates run with workers paused, from `pauseAt` to `unpauseAt`, as `eusChannel` publishes them. */
  readonly pausedHops: readonly [PausedHop, ...PausedHop[]];
  /** The main route's next update after the leg, when it runs on a channel other than `eusChannel`. */
  readonly returnTo?: { readonly channel: string; readonly hop: PathHop };
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
  const index = indexOf(eus.graph);
  const notOnEus = required.find((hop) => !publishes(index, hop));
  if (notOnEus) return { ...span, kind: 'unavailable', reason: { kind: 'notOnEus', hop: notOnEus } };

  // Patch hops inside the destination may run unpaused as ordinary updates, so they only decide how long the pause can last.
  let last = arrivalHop;
  while (last < lastHopInDestination) {
    const next = hops[last + 1] as PathHop;
    if (!isStableOrEusHop(next) || !publishes(index, next)) break;
    last += 1;
  }
  const [first, ...rest] = hops.slice(pauseHop, last + 1).map((hop) => pausedHop(index, hop)) as [PausedHop, ...PausedHop[]];
  const next = hops[last + 1];
  return {
    ...span,
    kind: 'available',
    pauseAt: first.from,
    unpauseAt: (rest.at(-1) ?? first).to,
    pausedHops: [first, ...rest],
    returnTo: next?.sourceChannel && next.sourceChannel !== span.eusChannel ? { channel: next.sourceChannel, hop: next } : undefined,
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
 * A point in the leg's procedure and the commands to run there, in order.
 * Each point is copied on its own: the points are separated by updates, so a
 * paste holding two of them would run the second before those updates happen.
 */
export interface LegCheckpoint {
  readonly kind: 'checkPools' | 'pause' | 'unpause' | 'waitForPools' | 'returnChannel';
  readonly when: string;
  readonly commands: readonly string[];
}

/** One update run with workers paused, on the leg's EUS channel. `upgradeTo` and `upgradeToImage` are alternatives, never run together. */
export interface LegUpdate {
  readonly kind: 'update';
  readonly hop: PausedHop;
  readonly upgradeTo: string;
  readonly upgradeToImage: string;
  /** Each risk the EUS channel and the main route's channel attach differently to this update. */
  readonly riskNotes: readonly string[];
}

export type LegStep = LegCheckpoint | LegUpdate;

function describeRisk(risk: Risk): string {
  return `${risk.name} (${riskClass(risk) === 'Always' ? 'Always' : 'conditional'})`;
}

function riskNotes(hop: PausedHop, eusChannel: string): readonly string[] {
  const routeChannel = hop.onRoute.sourceChannel ?? "the main route's channel";
  // A risk that changes class between channels is a difference too: Always fires on every cluster.
  const key = (risk: Risk) => `${riskIdOf(risk)}|${riskClass(risk)}`;
  const onRoute = new Set(hop.onRoute.risks.map(key));
  const onEus = new Set(hop.risks.map(key));
  const edge = `the update from ${hop.from} to ${hop.to}`;
  return [
    ...hop.risks.filter((risk) => !onRoute.has(key(risk))).map((risk) => `${eusChannel} attaches ${describeRisk(risk)} to ${edge}, which ${routeChannel} does not.`),
    ...hop.onRoute.risks.filter((risk) => !onEus.has(key(risk))).map((risk) => `${routeChannel} attaches ${describeRisk(risk)} to ${edge}, which ${eusChannel} does not.`),
  ];
}

/**
 * Red Hat's "Control Plane Only update using the CLI" for one leg: pools
 * settled, switch to eus-4.(E+2) and pause, the paused updates on that
 * channel, unpause, pools settled, then back to the main route's channel.
 */
export function legSteps(leg: AvailableLeg): readonly LegStep[] {
  const steps: LegStep[] = [
    {
      kind: 'checkPools',
      when: `At ${leg.pauseAt}, before the update to ${leg.pausedHops[0].to}, confirm that every pool reports UPDATED=True and UPDATING=False`,
      commands: ['oc get mcp'],
    },
    {
      kind: 'pause',
      when: `Then switch to ${leg.eusChannel} and pause workers. They stay paused through ${leg.unpauseAt}`,
      // Chained: on separate lines a failed switch would still pause workers on the old channel.
      commands: [`oc adm upgrade channel ${leg.eusChannel} && ${PAUSE_WORKERS_COMMAND}`],
    },
    ...leg.pausedHops.map(
      (hop): LegUpdate => ({
        kind: 'update',
        hop,
        upgradeTo: `oc adm upgrade --to ${hop.to}`,
        upgradeToImage: `oc adm upgrade --to-image=${hop.payload} --allow-explicit-upgrade`,
        riskNotes: riskNotes(hop, leg.eusChannel),
      }),
    ),
    { kind: 'unpause', when: `Once the cluster reports ${leg.unpauseAt}`, commands: [UNPAUSE_WORKERS_COMMAND] },
    {
      kind: 'waitForPools',
      when: `Before the next update of any kind, including a patch update within ${formatStream(leg.to)}, wait until every pool you paused reports UPDATED=True and UPDATING=False`,
      commands: ['oc get mcp'],
    },
  ];
  if (leg.returnTo) {
    const { channel, hop } = leg.returnTo;
    steps.push({
      kind: 'returnChannel',
      when: `Then return to ${channel}, the channel the main route takes its next update, from ${hop.from} to ${hop.to}, on`,
      commands: [`oc adm upgrade channel ${channel}`],
    });
  }
  return steps;
}
