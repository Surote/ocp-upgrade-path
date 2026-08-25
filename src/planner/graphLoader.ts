import type { GraphClient } from '../graph/client';
import { ok, type Result } from '../lib/result';
import type { GraphLoader } from '../engine/types';
import type { Graph } from '../graph/types';
import type { GraphError } from '../graph/errors';

/**
 * Adapts `GraphClient.getGraph` to the engine's `GraphLoader` injection seam
 * (engine/types.ts) -- the stitcher (engine/stitch.ts) never touches
 * `GraphClient` directly, so this is the one place a `GraphClient` gets
 * wired into the pathfinding engine. Discards `fetchedAt`: the pure
 * path-search doesn't need it, and the freshness banner reads
 * `GraphClient.getGraph` results directly (see `useGraphForSelection.ts`),
 * not through this adapter.
 *
 * `signal`, when provided, is threaded through to every underlying
 * `getGraph` call the stitcher makes (one per channel it walks back
 * through) so a superseded search's in-flight network requests are aborted,
 * not just ignored -- see `useAsyncResult.ts` for the "stale response must
 * never win" guard this composes with.
 */
export function makeGraphLoader(client: GraphClient, options?: { readonly signal?: AbortSignal }): GraphLoader {
  return async (channel, arch): Promise<Result<Graph, GraphError>> => {
    const result = await client.getGraph({ channel, arch }, { signal: options?.signal });
    if (!result.ok) return result;
    return ok(result.value.graph);
  };
}
