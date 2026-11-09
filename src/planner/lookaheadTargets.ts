import { useCallback } from 'react';
import { parseChannelName } from '../design/channels';
import { candidateChannelsForStream } from '../design/forwardChannel';
import { reachableFrom } from '../engine/reachability';
import { compareStreams, compareVersions, formatStream, type Stream } from '../engine/version';
import type { GraphClient } from '../graph/client';
import type { Arch, Graph, Version } from '../graph/types';
import { ok, type Result } from '../lib/result';
import { type AsyncResult, useAsyncResult } from './useAsyncResult';

/**
 * Bound on how many streams beyond the anchor's own are fetched for
 * look-ahead targets (plan.md §6 "Look-ahead targets (bidirectional
 * stitching)": "be pragmatic about fetch cost -- do not fetch every channel
 * in existence on page load"). Only channels that real membership data
 * already names are fetched, so this is at most `LOOKAHEAD_STEPS` extra
 * requests, only once the user has selected a channel, and cached by
 * `GraphClient` afterward -- including for the engine's later forward walk.
 */
const LOOKAHEAD_STEPS = 3;

export interface LookaheadSegment {
  readonly channel: string;
  readonly graph: Graph;
  /** True when this segment's class differs from the anchor's (plan.md §6 "Forward channel preference"). */
  readonly classFallback: boolean;
  /** The anchor's class, which had no channel at this stream -- present iff `classFallback` is true. */
  readonly requestedClass?: string;
}

/**
 * Lazily discovers up to `LOOKAHEAD_STEPS` channels in streams newer than
 * the anchor's, lowest stream first. Which streams come next is read from
 * channel membership, not computed: a node's metadata lists every channel it
 * belongs to, including the next streams' channels it is an upgrade source
 * for (4.22.z lists `candidate-4.23` and `candidate-5.0`). Neither "4.23"
 * nor "5.0" can be derived from "4.22" arithmetically, and both are real
 * successors. Each fetched segment's own membership extends the frontier, so
 * 5.1 is found through `candidate-5.0`.
 *
 * At each stream the class is chosen by `candidateChannelsForStream` (shared
 * with engine/stitch.ts so the two prefer channels identically), restricted
 * to names membership attests.
 *
 * Uses `GraphClient` directly rather than the engine's `GraphLoader`
 * injection seam: this is a UI-only concern (populating a dropdown before
 * any path search has run), and it needs the client's two-tier cache.
 *
 * Returns an empty list when `anchorChannel` doesn't match Cincinnati's
 * `<class>-<major>.<minor>` naming convention, and degrades to the segments
 * found so far on any fetch failure -- this is a dropdown convenience, not a
 * place to surface hard errors.
 */
export async function discoverLookaheadSegments(
  client: GraphClient,
  anchorChannel: string,
  arch: Arch,
  signal?: AbortSignal,
): Promise<readonly LookaheadSegment[]> {
  const anchor = parseChannelName(anchorChannel);
  if (!anchor) return [];
  const anchorResult = await client.getGraph({ channel: anchorChannel, arch }, { signal });
  if (!anchorResult.ok) return [];

  const attested = new Set(anchorResult.value.graph.channelNames);
  const visitedStreams = new Set<string>([formatStream(anchor)]);
  const segments: LookaheadSegment[] = [];

  while (segments.length < LOOKAHEAD_STEPS) {
    const stream = lowestNewerStream(attested, anchor, visitedStreams);
    if (!stream) break;
    visitedStreams.add(formatStream(stream));

    for (const channel of candidateChannelsForStream(anchor.cls, stream).filter((name) => attested.has(name))) {
      const result = await client.getGraph({ channel, arch }, { signal });
      if (!result.ok) {
        if (result.error.kind === 'empty') continue;
        return segments;
      }
      const classFallback = parseChannelName(channel)?.cls !== anchor.cls;
      segments.push({ channel, graph: result.value.graph, classFallback, requestedClass: classFallback ? anchor.cls : undefined });
      for (const name of result.value.graph.channelNames) attested.add(name);
      break;
    }
  }
  return segments;
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

export interface LookaheadTargetOption {
  readonly version: Version;
  readonly disabled: boolean;
  readonly reason?: string;
  /** The channel this candidate was actually found in -- always beyond the anchor's own graph, so choosing it requires a real channel switch. */
  readonly viaChannel: string;
  /** True when `viaChannel` is a different class than the anchor's (plan.md §6) -- surfaced so the UI can call it out explicitly, per requirement 5. */
  readonly classFallback: boolean;
}

/**
 * Builds look-ahead target options from already-discovered `segments`
 * (ascending-stream order, as `discoverLookaheadSegments` returns them):
 * every version in a segment's graph not already present in `anchorGraph`,
 * marked reachable/unreachable by carrying a "reachable so far" frontier
 * from `start` through the anchor and then into each segment in turn,
 * using only that segment's own edges at each step. The frontier is the
 * union over every earlier segment, not just the previous one, because
 * successor streams can be siblings (4.23 and 5.0 both follow 4.22) rather
 * than a chain. This mirrors the
 * stitcher's "never union edges across graphs" rule (plan.md §4) rather than
 * assuming every listed version is reachable just because a channel exists.
 */
export function buildLookaheadTargetOptions(
  anchorGraph: Graph,
  start: Version,
  segments: readonly LookaheadSegment[],
): readonly LookaheadTargetOption[] {
  const seen = new Set<Version>(anchorGraph.nodes.map((n) => n.version));
  let frontier = reachableFrom(anchorGraph, start);

  const options: LookaheadTargetOption[] = [];

  for (const segment of segments) {
    const segmentVersions = new Set(segment.graph.nodes.map((n) => n.version));

    const entry = new Set<Version>();
    for (const ver of frontier) {
      if (segmentVersions.has(ver)) entry.add(ver);
    }

    const reachableInSegment = new Set<Version>();
    for (const e of entry) {
      for (const ver of reachableFrom(segment.graph, e)) reachableInSegment.add(ver);
    }

    for (const node of segment.graph.nodes) {
      if (seen.has(node.version)) continue;
      seen.add(node.version);
      const disabled = !reachableInSegment.has(node.version);
      options.push({
        version: node.version,
        disabled,
        reason: disabled ? 'not reachable from the selected start version through the discovered forward channels' : undefined,
        viaChannel: segment.channel,
        classFallback: segment.classFallback,
      });
    }

    frontier = new Set([...frontier, ...reachableInSegment]);
  }

  return [...options].sort((a, b) => compareVersions(b.version, a.version));
}

/**
 * Fetches (and caches, via `discoverLookaheadSegments`) the look-ahead
 * segments for the currently selected `channel`, active only once a channel
 * is actually selected. This never errors outward -- a failed lookahead
 * fetch degrades to "fewer look-ahead targets offered" (see
 * `discoverLookaheadSegments`'s doc), not a broken dropdown -- so the result
 * type's error is `never`.
 */
export function useLookaheadSegments(
  client: GraphClient,
  channel: string | undefined,
  arch: Arch,
): AsyncResult<readonly LookaheadSegment[], never> {
  const active = channel !== undefined;
  const depsKey = channel ? `${channel}|${arch}` : '';

  const task = useCallback(
    (signal: AbortSignal): Promise<Result<readonly LookaheadSegment[], never>> =>
      discoverLookaheadSegments(client, channel as string, arch, signal).then(ok),
    [client, channel, arch],
  );

  return useAsyncResult(active, depsKey, task);
}
