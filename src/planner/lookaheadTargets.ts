import { useCallback } from 'react';
import { parseChannelName } from '../design/channels';
import { candidateChannelsForStream } from '../design/forwardChannel';
import { reachableFrom } from '../engine/reachability';
import { compareVersions } from '../engine/version';
import type { GraphClient } from '../graph/client';
import type { Arch, Graph, Version } from '../graph/types';
import { ok, type Result } from '../lib/result';
import { type AsyncResult, useAsyncResult } from './useAsyncResult';

/**
 * Bound on how many extra minors beyond the anchor channel's own maximum
 * minor are probed for look-ahead targets (plan.md §6 "Look-ahead targets
 * (bidirectional stitching)": "be pragmatic about fetch cost -- do not fetch
 * every channel in existence on page load"). Each step probes at most two
 * candidates (the anchor's own class, then `stable` -- `candidateChannelsForMinor`),
 * so this bounds discovery to at most `2 * LOOKAHEAD_STEPS` extra network
 * requests, and only once the user has actually selected a channel (never on
 * page load, never for every channel that exists) -- cached by `GraphClient`'s
 * own two-tier cache afterward, so re-visiting the same channel, or the
 * engine's own later forward walk for whatever target the user actually
 * picks, costs nothing further.
 */
const LOOKAHEAD_STEPS = 3;

export interface LookaheadSegment {
  readonly channel: string;
  readonly graph: Graph;
  /** True when this segment came from the `stable` fallback rather than the anchor's own class (plan.md §6 "Forward channel preference"). */
  readonly classFallback: boolean;
  /** The class that was preferred but unavailable at this minor -- present iff `classFallback` is true. */
  readonly requestedClass?: string;
}

/**
 * Lazily discovers up to `LOOKAHEAD_STEPS` channels beyond the anchor's own
 * maximum minor, walking outward one minor at a time (same-class preferred,
 * `stable` fallback), stopping early the first minor where *neither* variant
 * exists -- taken as a signal there is nothing released that far ahead yet,
 * not a reason to keep probing. Shares `candidateChannelsForMinor` with the
 * engine's own forward walk (engine/stitch.ts) so the two can never name a
 * channel differently.
 *
 * Uses `GraphClient` directly rather than the engine's `GraphLoader`
 * injection seam: this is a UI-only concern (populating a dropdown before
 * any actual path search has run), not part of the pure path-search engine,
 * and it specifically needs the client's own two-tier cache.
 *
 * Returns an empty list (no fetches at all) when `anchorChannel` doesn't
 * match Cincinnati's `<class>-<major>.<minor>` naming convention -- there is no
 * minor to walk forward from.
 */
export async function discoverLookaheadSegments(
  client: GraphClient,
  anchorChannel: string,
  arch: Arch,
  signal?: AbortSignal,
): Promise<readonly LookaheadSegment[]> {
  const anchor = parseChannelName(anchorChannel);
  if (!anchor) return [];
  const preferredClass = anchor.cls;

  const segments: LookaheadSegment[] = [];
  for (let step = 1; step <= LOOKAHEAD_STEPS; step += 1) {
    const candidates = candidateChannelsForStream(preferredClass, { major: anchor.major, minor: anchor.minor + step });
    let found: LookaheadSegment | undefined;

    for (let ci = 0; ci < candidates.length; ci += 1) {
      const channel = candidates[ci] as string;
      const result = await client.getGraph({ channel, arch }, { signal });
      if (result.ok) {
        found = {
          channel,
          graph: result.value.graph,
          classFallback: ci > 0,
          requestedClass: ci > 0 ? preferredClass : undefined,
        };
        break;
      }
      // 'empty' = the channel genuinely doesn't exist (Cincinnati's HTTP
      // 200 + empty-arrays signal) -- try the next candidate. Anything else
      // is a real failure; discovery degrades quietly rather than surfacing
      // a hard error for what is, at this point, only a dropdown convenience.
      if (result.error.kind !== 'empty') return segments;
    }

    if (!found) break;
    segments.push(found);
  }
  return segments;
}

export interface LookaheadTargetOption {
  readonly version: Version;
  readonly disabled: boolean;
  readonly reason?: string;
  /** The channel this candidate was actually found in -- always beyond the anchor's own graph, so choosing it requires a real channel switch. */
  readonly viaChannel: string;
  /** True when reaching `viaChannel` required the eus -> stable class fallback (plan.md §6) -- surfaced so the UI can call it out explicitly, per requirement 5. */
  readonly classFallback: boolean;
}

/**
 * Builds look-ahead target options from already-discovered `segments`
 * (ascending-minor order, as `discoverLookaheadSegments` returns them):
 * every version in a segment's graph not already present in `anchorGraph`,
 * marked reachable/unreachable by carrying a "reachable so far" frontier
 * from `start` through the anchor and then through each segment in turn,
 * using only that segment's own edges at each step -- mirroring the
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

    frontier = reachableInSegment;
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
