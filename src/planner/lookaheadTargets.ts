import { useCallback } from 'react';
import { discoverLookahead, type LookaheadDiscovery } from '../engine/lookahead';
import type { GraphClient, GraphResult } from '../graph/client';
import type { Arch } from '../graph/types';
import { ok, type Result } from '../lib/result';
import { makeGraphLoader } from './graphLoader';
import { type AsyncResult, useAsyncResult } from './useAsyncResult';

/** Look-ahead discovered from one loaded anchor graph. */
export interface LookaheadSnapshot {
  /** `GraphResult.fetchedAt` of the anchor graph this was discovered from: it names one cache entry, so one graph. */
  readonly anchorFetchedAt: number;
  readonly discovery: LookaheadDiscovery;
}

/**
 * The look-ahead channels beyond `channel` (engine/lookahead.ts), discovered
 * from the anchor graph the dropdowns are built from rather than a separate
 * fetch of it, so a manual refresh of the anchor rediscovers. Read through
 * `GraphClient`'s cache. Never errors outward: a failed look-ahead fetch is
 * recorded in `discovery.failure` and means fewer targets offered, not a
 * broken dropdown.
 */
export function useLookahead(
  client: GraphClient,
  channel: string | undefined,
  arch: Arch,
  anchor: GraphResult | undefined,
): AsyncResult<LookaheadSnapshot, never> {
  const active = channel !== undefined && anchor !== undefined;
  const depsKey = active ? `${channel}|${arch}|${anchor.fetchedAt}` : '';

  const task = useCallback(
    async (signal: AbortSignal): Promise<Result<LookaheadSnapshot, never>> => {
      const { graph, fetchedAt } = anchor as GraphResult;
      const discovery = await discoverLookahead(makeGraphLoader(client, { signal }), channel as string, graph, arch);
      return ok({ anchorFetchedAt: fetchedAt, discovery });
    },
    [client, channel, arch, anchor],
  );

  return useAsyncResult(active, depsKey, task);
}
