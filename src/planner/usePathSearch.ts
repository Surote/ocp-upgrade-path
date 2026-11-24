import { useCallback } from 'react';
import { type AnchorSnapshot, stitchAndFindPath } from '../engine/stitch';
import type { StitchedPathResult, StitchError } from '../engine/types';
import type { GraphClient } from '../graph/client';
import type { Arch, Version } from '../graph/types';
import { makeGraphLoader } from './graphLoader';
import { type AsyncResult, useAsyncResult } from './useAsyncResult';

export interface PathSearchParams {
  /** The target's channel -- the stitcher fetches this first and walks back only if `start` isn't in it (engine/stitch.ts). */
  readonly channel: string | undefined;
  readonly arch: Arch;
  readonly start: Version | undefined;
  readonly target: Version | undefined;
  /** The anchor graph the dropdowns were built from, and the look-ahead discovered from it once known; routed against instead of refetched. */
  readonly anchor?: AnchorSnapshot & { readonly fetchedAt: number };
}

/**
 * Runs `stitchAndFindPath` for the current (channel, arch, start, target)
 * selection, active only once all four are resolved. Wires the engine's
 * `GraphLoader` injection seam to the real `GraphClient` via
 * `makeGraphLoader` -- this is the only place in the UI layer that touches
 * the stitcher directly.
 */
export function usePathSearch(client: GraphClient, params: PathSearchParams): AsyncResult<StitchedPathResult, StitchError> {
  const { channel, arch, start, target, anchor } = params;
  const active = channel !== undefined && start !== undefined && target !== undefined;
  const depsKey = active ? `${channel}|${arch}|${start}|${target}|${anchor?.fetchedAt}` : '';

  const task = useCallback(
    (signal: AbortSignal) => {
      const loader = makeGraphLoader(client, { signal });
      return stitchAndFindPath(loader, {
        targetChannel: channel as string,
        arch,
        start: start as Version,
        target: target as Version,
        anchor,
      });
    },
    [client, channel, arch, start, target, anchor],
  );

  return useAsyncResult(active, depsKey, task);
}
