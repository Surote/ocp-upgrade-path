import { useCallback } from 'react';
import type { GraphClient, GraphResult } from '../graph/client';
import type { GraphError } from '../graph/errors';
import type { Arch } from '../graph/types';
import { type AsyncResult, useAsyncResult } from './useAsyncResult';

export type GraphSelectionResult = AsyncResult<GraphResult, GraphError> & {
  /** Invalidates both cache tiers for this (channel, arch) then re-fetches -- the manual "freshness" refresh path (plan.md §3: "a visible fetch timestamp and manual refresh"). Distinct from `retry`, which just re-runs the same fetch (and would normally re-hit a warm cache). */
  readonly refresh: () => void;
};

/**
 * Fetches the `Graph` for one `(channel, arch)` pair -- the source for both
 * the start and target dropdowns in this phase (see the implementation
 * report for the resulting limitation on the start dropdown). Inactive
 * (`status: 'idle'`) whenever `channel` is unset, so an unselected channel
 * never shows a spurious loading/error state.
 */
export function useGraphForSelection(client: GraphClient, channel: string | undefined, arch: Arch): GraphSelectionResult {
  const depsKey = channel ? `${channel}|${arch}` : '';
  const active = channel !== undefined;

  const task = useCallback(
    (signal: AbortSignal) => client.getGraph({ channel: channel as string, arch }, { signal }),
    [client, channel, arch],
  );

  const asyncResult = useAsyncResult(active, depsKey, task);

  // `asyncResult.retry` is intentionally omitted from the deps below: it's a
  // `useCallback(() => ..., [])`-stable function identity (see
  // useAsyncResult.ts), so it never needs to trigger a re-creation here.
  const retry = asyncResult.retry;
  const refresh = useCallback(() => {
    if (channel) client.invalidate({ channel, arch });
    retry();
  }, [client, channel, arch, retry]);

  return { ...asyncResult, refresh };
}
