import { parseChannelName } from '../design/channels';
import { candidateChannelsForStream } from '../design/forwardChannel';
import type { GraphError } from '../graph/errors';
import type { Arch, Graph } from '../graph/types';
import type { GraphLoader } from './types';
import { compareStreams, formatStream, type Stream } from './version';

/**
 * Safety bound only. Discovery normally ends when no fetched graph names a
 * newer channel it has not tried; an eus-4.18 anchor reaches 5.1 in seven
 * streams. Twelve streams, four classes each.
 */
const MAX_LOOKAHEAD_FETCHES = 48;

export interface ChannelSegment {
  readonly channel: string;
  readonly graph: Graph;
  /** True when this segment's class differs from the anchor's (plan.md §6 "Forward channel preference"). */
  readonly classFallback: boolean;
  /** The anchor's class, which had no channel at this stream -- present iff `classFallback` is true. */
  readonly requestedClass?: string;
}

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

  const attested = new Set(anchorGraph.channelNames);
  const failedStreams = new Set<string>();
  let failure: LookaheadDiscovery['failure'];

  for (let fetches = 0; fetches < MAX_LOOKAHEAD_FETCHES; fetches += 1) {
    const next = nextChannel(attested, anchor, channelsTried, found, failedStreams);
    if (!next) break;
    channelsTried.push(next.channel);
    const result = await loader(next.channel, arch);
    if (!result.ok) {
      if (result.error.kind === 'empty') continue;
      failure ??= { channel: next.channel, error: result.error };
      // Stop at this stream rather than try the next class: a transient
      // error must not silently move the plan onto another class.
      failedStreams.add(formatStream(next.stream));
      continue;
    }
    const classFallback = next.rank > 0;
    found.push({
      ...next,
      segment: { channel: next.channel, graph: result.value, classFallback, requestedClass: classFallback ? anchor.cls : undefined },
    });
    for (const name of result.value.channelNames) attested.add(name);
  }
  // A fetched graph can name a stream older than one already fetched (only
  // 5.1 names 4.23), and routeAcrossSegments visits each segment once.
  found.sort((a, b) => compareStreams(a.stream, b.stream) || b.rank - a.rank);
  return { segments: found.map((f) => f.segment), channelsTried, failure };
}

interface Candidate {
  readonly channel: string;
  readonly stream: Stream;
  /** Position in `candidateChannelsForStream`: 0 is the anchor's own class. */
  readonly rank: number;
}

interface Found extends Candidate {
  readonly segment: ChannelSegment;
}

/**
 * The next channel to fetch: at the lowest newer stream that has one, the
 * most preferred attested channel not yet tried that would beat every
 * channel already found there.
 */
function nextChannel(
  attested: ReadonlySet<string>,
  anchor: Stream & { readonly cls: string },
  tried: readonly string[],
  found: readonly Found[],
  failedStreams: ReadonlySet<string>,
): Candidate | undefined {
  let best: Candidate | undefined;
  for (const name of attested) {
    const parsed = parseChannelName(name);
    if (!parsed || compareStreams(parsed, anchor) <= 0 || failedStreams.has(formatStream(parsed)) || tried.includes(name)) continue;
    const stream = { major: parsed.major, minor: parsed.minor };
    const rank = candidateChannelsForStream(anchor.cls, stream).indexOf(name);
    if (rank < 0 || found.some((f) => compareStreams(f.stream, stream) === 0 && f.rank <= rank)) continue;
    if (!best || compareStreams(stream, best.stream) < 0 || (compareStreams(stream, best.stream) === 0 && rank < best.rank)) {
      best = { channel: name, stream, rank };
    }
  }
  return best;
}
