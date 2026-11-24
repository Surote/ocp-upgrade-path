import type { PathHop } from '../engine/types';
import { formatStream, type Stream, streamOf } from '../engine/version';
import type { Version } from '../graph/types';
import { parseChannelName } from './channels';

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
 * versions involved have been made available in `stable` channels", and runs
 * it on `eus-<4.y+2>`, which receives each release when stable does. So a hop
 * qualifies only when the planner took its edge from an eus or stable graph;
 * a fast or candidate edge may not be in stable yet.
 */
const CONTROL_PLANE_ONLY_CLASSES: ReadonlySet<string> = new Set(['eus', 'stable']);

function isControlPlaneOnlyHop(hop: PathHop): boolean {
  const cls = hop.sourceChannel === undefined ? undefined : parseChannelName(hop.sourceChannel)?.cls;
  return cls !== undefined && CONTROL_PLANE_ONLY_CLASSES.has(cls);
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
  readonly docsUrl: string;
}

/** Every hop from the pause point to the unpause point came from an eus or stable graph. */
export interface AvailableLeg extends LegSpan {
  readonly kind: 'available';
  /** Last route version in `from`: pause here, right before the hop into `via`. */
  readonly pauseAt: Version;
  /** First route version in `via`, the first hop taken with workers paused. */
  readonly firstPausedHopTo: Version;
  /** Last route version in `to`: unpause here, and let workers finish before leaving `to`. */
  readonly unpauseAt: Version;
}

/** The span crosses a hop Red Hat does not offer a Control Plane Only update over, so it has no pause steps. */
export interface UnavailableLeg extends LegSpan {
  readonly kind: 'unavailable';
  /** The span's first hop whose edge came from neither an eus nor a stable channel. */
  readonly blockingHop: PathHop;
}

export type ControlPlaneOnlyLeg = AvailableLeg | UnavailableLeg;

interface StreamRun {
  readonly stream: Stream;
  readonly first: Version;
  readonly last: Version;
  /** Index of `last` in the route's versions; hop `i` arrives at version `i + 1`. */
  readonly lastIndex: number;
}

function streamRuns(versions: readonly Version[]): StreamRun[] {
  const runs: StreamRun[] = [];
  versions.forEach((version, index) => {
    const stream = streamOf(version);
    const prev = runs.at(-1);
    if (prev && formatStream(prev.stream) === formatStream(stream)) {
      runs[runs.length - 1] = { ...prev, last: version, lastIndex: index };
    } else {
      runs.push({ stream, first: version, last: version, lastIndex: index });
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

/**
 * The Control Plane Only legs of an actual route (`Path.hops`, after stops
 * and avoids), in order. Cincinnati does not encode this -- it is
 * UI-side guidance (EusAdvisory.tsx). Consecutive legs share their EUS
 * stream: one leg's unpause point is the next leg's pause point.
 */
export function controlPlaneOnlyLegs(hops: readonly PathHop[]): readonly ControlPlaneOnlyLeg[] {
  const first = hops[0];
  const runs = streamRuns(first ? [first.from, ...hops.map((hop) => hop.to)] : []);
  const legs: ControlPlaneOnlyLeg[] = [];
  let i = 0;
  while (i + 2 < runs.length) {
    const [a, b, c] = [runs[i], runs[i + 1], runs[i + 2]] as [StreamRun, StreamRun, StreamRun];
    if (!isLegStart(a, b, c)) {
      i += 1;
      continue;
    }
    const span: LegSpan = {
      from: a.stream,
      via: b.stream,
      to: c.stream,
      docsUrl: `https://docs.redhat.com/en/documentation/openshift_container_platform/${formatStream(c.stream)}/html/updating_clusters/performing-a-cluster-update#control-plane-only-update`,
    };
    const blockingHop = hops.slice(a.lastIndex, c.lastIndex).find((hop) => !isControlPlaneOnlyHop(hop));
    legs.push(
      blockingHop
        ? { ...span, kind: 'unavailable', blockingHop }
        : { ...span, kind: 'available', pauseAt: a.last, firstPausedHopTo: b.first, unpauseAt: c.last },
    );
    i += 2;
  }
  return legs;
}

/**
 * A point in the leg's hop sequence and the one command to run there. Each
 * is copied on its own: the points are separated by updates, so a paste
 * holding two of them would run the second before those updates happen.
 */
export interface LegCheckpoint {
  readonly kind: 'pause' | 'unpause' | 'waitForPools';
  readonly when: string;
  readonly command: string;
}

export function legCheckpoints(leg: AvailableLeg): readonly LegCheckpoint[] {
  return [
    { kind: 'pause', when: `At ${leg.pauseAt}, before oc adm upgrade --to ${leg.firstPausedHopTo}`, command: PAUSE_WORKERS_COMMAND },
    { kind: 'unpause', when: `Once the cluster reports ${leg.unpauseAt}`, command: UNPAUSE_WORKERS_COMMAND },
    { kind: 'waitForPools', when: `Wait for worker UPDATED=True before leaving ${formatStream(leg.to)}`, command: 'oc get mcp' },
  ];
}
