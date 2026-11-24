import { parseChannelName } from '../design/channels';
import { candidateChannelsForStream } from '../design/forwardChannel';
import type { GraphError } from '../graph/errors';
import type { Arch, Graph } from '../graph/types';
import type { GraphLoader } from './types';
import { compareStreams, formatStream, type Stream } from './version';

/**
 * Safety bound only. Discovery normally ends when no fetched graph names a
 * newer stream; an eus-4.18 anchor reaches 5.1 in seven streams.
 */
const MAX_LOOKAHEAD_STREAMS = 12;

export interface ChannelSegment {
  readonly channel: string;
  readonly graph: Graph;
  /** True when this segment's class differs from the anchor's (plan.md §6 "Forward channel preference"). */
  readonly classFallback: boolean;
  /** The anchor's class, which had no channel at this stream -- present iff `classFallback` is true. */
  readonly requestedClass?: string;
}

export interface LookaheadDiscovery {
  /** Lowest stream first, at most one channel per stream. */
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
 * The channels beyond the anchor, one per newer stream, that both the target
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
 * that exists but no earlier node names (`stable-5.0` holding only 5.0.z)
 * has no upgrade sources here, so it can't join the walk.
 *
 * At each stream the class is chosen by `candidateChannelsForStream`,
 * restricted to attested names; an empty channel falls through to the next.
 * A channel that fails to load is recorded in `failure` and its stream skipped.
 */
export async function discoverLookahead(
  loader: GraphLoader,
  anchorChannel: string,
  anchorGraph: Graph,
  arch: Arch,
): Promise<LookaheadDiscovery> {
  const anchor = parseChannelName(anchorChannel);
  const segments: ChannelSegment[] = [];
  const channelsTried: string[] = [];
  if (!anchor) return { segments, channelsTried };

  const attested = new Set(anchorGraph.channelNames);
  const visitedStreams = new Set<string>([formatStream(anchor)]);
  let failure: LookaheadDiscovery['failure'];

  for (let step = 0; step < MAX_LOOKAHEAD_STREAMS; step += 1) {
    const stream = lowestNewerStream(attested, anchor, visitedStreams);
    if (!stream) break;
    visitedStreams.add(formatStream(stream));

    for (const channel of candidateChannelsForStream(anchor.cls, stream).filter((name) => attested.has(name))) {
      channelsTried.push(channel);
      const result = await loader(channel, arch);
      if (!result.ok) {
        if (result.error.kind === 'empty') continue;
        // Skip the stream rather than try the next class: a transient error
        // must not silently move the plan onto another class.
        failure ??= { channel, error: result.error };
        break;
      }
      const classFallback = parseChannelName(channel)?.cls !== anchor.cls;
      segments.push({ channel, graph: result.value, classFallback, requestedClass: classFallback ? anchor.cls : undefined });
      for (const name of result.value.channelNames) attested.add(name);
      break;
    }
  }
  return { segments, channelsTried, failure };
}

function lowestNewerStream(channelNames: ReadonlySet<string>, than: Stream, exclude: ReadonlySet<string>): Stream | undefined {
  let lowest: Stream | undefined;
  for (const name of channelNames) {
    const parsed = parseChannelName(name);
    if (!parsed || compareStreams(parsed, than) <= 0 || exclude.has(formatStream(parsed))) continue;
    if (!lowest || compareStreams(parsed, lowest) < 0) lowest = { major: parsed.major, minor: parsed.minor };
  }
  return lowest;
}
