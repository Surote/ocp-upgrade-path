import { parseChannelName } from '../design/channels';
import { candidateChannelsForStream } from '../design/forwardChannel';
import type { GraphError } from '../graph/errors';
import type { Arch, Graph } from '../graph/types';
import type { ClassFallback, GraphLoader } from './types';
import { compareStreams, formatStream, type Stream } from './version';

/**
 * Safety bound only. Discovery normally ends when no fetched graph names a
 * newer channel it has not tried; an eus-4.18 anchor reaches 5.1 in seven
 * streams. Twelve streams, four classes each.
 */
const MAX_LOOKAHEAD_FETCHES = 48;

/** `classFallback` is true when this segment's class differs from the anchor's (plan.md §6 "Forward channel preference"). */
export type ChannelSegment = { readonly channel: string; readonly graph: Graph } & (
  | { readonly classFallback: false }
  | ({ readonly classFallback: true } & Omit<ClassFallback, 'channel'>)
);

export interface LookaheadDiscovery {
  /**
   * Lowest stream first. A stream can hold a fallback and then a more
   * preferred channel named only after the fallback was fetched (fast-5.0's
   * releases name stable-5.0); the fallback comes first, so a route can
   * enter the stream on it and move to the preferred one.
   */
  readonly segments: readonly ChannelSegment[];
  /** Every channel fetched, in fetch order. */
  readonly channelsTried: readonly string[];
  /**
   * The first fetch that failed for a reason other than "channel is empty".
   * Discovery carries on past it, since successor streams are siblings (4.23
   * and 5.0 both follow 4.22), so callers report it only when no route is found.
   */
  readonly failure?: { readonly channel: string; readonly error: GraphError };
}

/**
 * The channels beyond the anchor, by newer stream, that both the target
 * dropdown (planner/targetOptions.ts) and the stitcher's forward walk
 * (engine/stitch.ts) use. Sharing this one walk is what makes every target
 * the dropdown marks reachable routable by the stitcher.
 *
 * Which streams come next is read from channel membership, not computed: a
 * node's metadata lists every channel it belongs to, including the next
 * streams' channels it is an upgrade source for (4.22.z lists
 * `candidate-4.23` and `fast-5.0`). Neither "4.23" nor "5.0" can be derived
 * from "4.22" arithmetically, and both are real successors. Each fetched
 * segment's own membership extends the frontier, so 5.1 is found through a
 * 4.23 or 5.0 channel. Only membership-attested names are fetched: a channel
 * that exists but no reached node names has no release in common with the
 * walk, so it can't join it.
 *
 * At each stream the class is chosen by `candidateChannelsForStream`,
 * restricted to attested names; an empty channel falls through to the next.
 * A more preferred channel attested later is fetched too, and the fallback
 * stays: the route search (`routeAcrossSegments`) ranks posture first, so it
 * uses the preferred channel wherever it reaches. A channel that fails to
 * load is recorded in `failure`, and its stream gets no further channels.
 */
export async function discoverLookahead(
  loader: GraphLoader,
  anchorChannel: string,
  anchorGraph: Graph,
  arch: Arch,
): Promise<LookaheadDiscovery> {
  const anchor = parseChannelName(anchorChannel);
  const found: Found[] = [];
  const channelsTried: string[] = [];
  if (!anchor) return { segments: [], channelsTried };

  // Fetch count at which each channel was first named, for `nextChannel`.
  const attested = new Map(anchorGraph.channelNames.map((name) => [name, 0]));
  const failedStreams = new Set<string>();
  const emptyChannels = new Set<string>();
  const failedChannels = new Set<string>();
  let failure: LookaheadDiscovery['failure'];

  for (let fetches = 0; fetches < MAX_LOOKAHEAD_FETCHES; fetches += 1) {
    const next = nextChannel(attested, anchor, channelsTried, found, failedStreams);
    if (!next) break;
    channelsTried.push(next.channel);
    const result = await loader(next.channel, arch);
    if (!result.ok) {
      if (result.error.kind === 'empty') {
        emptyChannels.add(next.channel);
        continue;
      }
      failure ??= { channel: next.channel, error: result.error };
      failedChannels.add(next.channel);
      // Stop at this stream rather than try the next class: a transient
      // error must not silently move the plan onto another class.
      failedStreams.add(formatStream(next.stream));
      continue;
    }
    found.push({ ...next, graph: result.value });
    for (const name of result.value.channelNames) if (!attested.has(name)) attested.set(name, channelsTried.length);
  }
  // A fetched graph can name a stream older than one already fetched (only
  // 5.1 names 4.23), and the route search never returns to an earlier stream.
  found.sort((a, b) => compareStreams(a.stream, b.stream) || b.rank - a.rank);
  const segments = found.map(({ channel, stream, rank, graph }): ChannelSegment => {
    if (rank === 0) return { channel, graph, classFallback: false };
    const requested = candidateChannelsForStream(anchor.cls, stream)[0] as string;
    const requestedStatus = emptyChannels.has(requested) ? 'unpublished' : failedChannels.has(requested) ? 'unverified' : 'noRoute';
    return { channel, graph, classFallback: true, requestedClass: anchor.cls, requestedStatus };
  });
  return { segments, channelsTried, failure };
}

interface Candidate {
  readonly channel: string;
  readonly stream: Stream;
  /** Position in `candidateChannelsForStream`: 0 is the anchor's own class. */
  readonly rank: number;
}

interface Found extends Candidate {
  readonly graph: Graph;
}

/**
 * The next channel to fetch: at the lowest newer stream that has one, the
 * most preferred attested channel not yet tried that would beat every
 * channel already found there and named no later than it. A preferred
 * channel named after a fallback (stable-5.1, named only by a late
 * stable-5.0) does not displace that fallback (fast-5.1, named by fast-5.0):
 * the route search, not discovery order, decides which one a route needs.
 */
function nextChannel(
  attested: ReadonlyMap<string, number>,
  anchor: Stream & { readonly cls: string },
  tried: readonly string[],
  found: readonly Found[],
  failedStreams: ReadonlySet<string>,
): Candidate | undefined {
  let best: Candidate | undefined;
  for (const [name, namedAt] of attested) {
    const parsed = parseChannelName(name);
    if (!parsed || compareStreams(parsed, anchor) <= 0 || failedStreams.has(formatStream(parsed)) || tried.includes(name)) continue;
    const stream = { major: parsed.major, minor: parsed.minor };
    const rank = candidateChannelsForStream(anchor.cls, stream).indexOf(name);
    const displaced = found.some((f) => compareStreams(f.stream, stream) === 0 && f.rank <= rank && (attested.get(f.channel) as number) <= namedAt);
    if (rank < 0 || displaced) continue;
    if (!best || compareStreams(stream, best.stream) < 0 || (compareStreams(stream, best.stream) === 0 && rank < best.rank)) {
      best = { channel: name, stream, rank };
    }
  }
  return best;
}
