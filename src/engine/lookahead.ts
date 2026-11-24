import { parseChannelName } from '../design/channels';
import { candidateChannelsForStream } from '../design/forwardChannel';
import type { GraphError } from '../graph/errors';
import type { Arch, Graph } from '../graph/types';
import type { ClassFallback, GraphLoader } from './types';
import { compareStreams, type Stream } from './version';

/**
 * Safety bound only. Discovery normally ends when no fetched graph names a
 * newer channel it has not tried; an eus-4.18 anchor reaches 5.1 in seven
 * streams and 19 fetches (Nov 2026). Twelve streams, four classes each.
 */
const MAX_LOOKAHEAD_FETCHES = 48;

/**
 * Fetches in flight at once. Each Cincinnati response streams at a few hundred
 * KB/s, so a wave of a stream's channels finishes far sooner side by side.
 */
const LOOKAHEAD_CONCURRENCY = 6;

/** `classFallback` is true when this segment's class differs from the anchor's (plan.md §6 "Forward channel preference"). */
export type ChannelSegment = { readonly channel: string; readonly graph: Graph } & (
  | { readonly classFallback: false }
  | ({ readonly classFallback: true } & Omit<ClassFallback, 'channel'>)
);

export interface LookaheadDiscovery {
  /** Lowest stream first; within a stream, every channel that loaded, least preferred first. */
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
 * Every attested channel of a class `candidateChannelsForStream` names is
 * fetched, preferred class first, up to the safety cap. Discovery never
 * decides a fallback is unneeded: whether a route needs fast-5.2 depends on
 * which channels reach it, which only the route search (`routeAcrossSegments`)
 * knows, and it ranks posture first, so it uses the preferred channel
 * wherever that reaches. A channel that fails to load is skipped and
 * recorded in `failure`; a fallback used at its stream reports the preferred
 * channel as `unverified` rather than discovery withholding the stream.
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
  const emptyChannels = new Set<string>();
  const failedChannels = new Set<string>();
  let failure: LookaheadDiscovery['failure'];

  // Discovery runs in waves: every attested channel not yet tried is fetched
  // together, then their membership names the next wave. The channels tried
  // are the same as one at a time, since the attested set only grows; the
  // order within a wave is fixed, so `channelsTried` and `failure` do not
  // depend on which fetch finishes first.
  for (;;) {
    const wave = untriedChannels(attested, anchor, channelsTried).slice(0, MAX_LOOKAHEAD_FETCHES - channelsTried.length);
    if (wave.length === 0) break;
    channelsTried.push(...wave.map((c) => c.channel));
    const results = await mapConcurrently(wave, LOOKAHEAD_CONCURRENCY, (c) => loader(c.channel, arch));
    wave.forEach((candidate, i) => {
      const result = results[i] as Awaited<ReturnType<GraphLoader>>;
      if (!result.ok) {
        if (result.error.kind === 'empty') {
          emptyChannels.add(candidate.channel);
          return;
        }
        failure ??= { channel: candidate.channel, error: result.error };
        failedChannels.add(candidate.channel);
        return;
      }
      found.push({ ...candidate, graph: result.value });
      for (const name of result.value.channelNames) attested.add(name);
    });
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

/** Attested channels not yet tried, lowest stream first, most preferred first within a stream. */
function untriedChannels(
  attested: ReadonlySet<string>,
  anchor: Stream & { readonly cls: string },
  tried: readonly string[],
): Candidate[] {
  const candidates: Candidate[] = [];
  for (const name of attested) {
    const parsed = parseChannelName(name);
    if (!parsed || compareStreams(parsed, anchor) <= 0 || tried.includes(name)) continue;
    const stream = { major: parsed.major, minor: parsed.minor };
    const rank = candidateChannelsForStream(anchor.cls, stream).indexOf(name);
    if (rank >= 0) candidates.push({ channel: name, stream, rank });
  }
  return candidates.sort((a, b) => compareStreams(a.stream, b.stream) || a.rank - b.rank);
}

/** `fn` over `items` with at most `limit` calls pending at once; results in input order. */
async function mapConcurrently<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next;
      next += 1;
      results[i] = await fn(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
