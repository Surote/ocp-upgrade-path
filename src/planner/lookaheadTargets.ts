import { useCallback } from 'react';
import { parseChannelName } from '../design/channels';
import { type ChannelSegment, discoverLookahead } from '../engine/lookahead';
import type { GraphClient } from '../graph/client';
import type { Arch } from '../graph/types';
import { ok, type Result } from '../lib/result';
import { makeGraphLoader } from './graphLoader';
import { type AsyncResult, useAsyncResult } from './useAsyncResult';

/**
 * The look-ahead channels beyond `anchorChannel` (engine/lookahead.ts), read
 * through `GraphClient`'s cache so the stitcher's own forward walk later
 * gets the very same graph snapshots.
 *
 * Returns an empty list for a channel name outside Cincinnati's
 * `<class>-<major>.<minor>` convention, without fetching anything, and
 * degrades to the segments found so far on a fetch failure -- this is a
 * dropdown convenience, not a place to surface hard errors.
 */
export async function discoverLookaheadSegments(
  client: GraphClient,
  anchorChannel: string,
  arch: Arch,
  signal?: AbortSignal,
): Promise<readonly ChannelSegment[]> {
  if (!parseChannelName(anchorChannel)) return [];
  const loader = makeGraphLoader(client, { signal });
  const anchor = await loader(anchorChannel, arch);
  if (!anchor.ok) return [];
  return (await discoverLookahead(loader, anchorChannel, anchor.value, arch)).segments;
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
): AsyncResult<readonly ChannelSegment[], never> {
  const active = channel !== undefined;
  const depsKey = channel ? `${channel}|${arch}` : '';

  const task = useCallback(
    (signal: AbortSignal): Promise<Result<readonly ChannelSegment[], never>> =>
      discoverLookaheadSegments(client, channel as string, arch, signal).then(ok),
    [client, channel, arch],
  );

  return useAsyncResult(active, depsKey, task);
}
