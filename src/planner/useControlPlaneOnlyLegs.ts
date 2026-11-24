import { useMemo } from 'react';
import { controlPlaneOnlyLegs, type ControlPlaneOnlyLeg, eusChannelsToCheck, type EusGraphState } from '../design/eus';
import type { PathHop, StitchedPathResult, StitchError } from '../engine/types';
import type { GraphClient } from '../graph/client';
import type { Arch } from '../graph/types';
import { ok } from '../lib/result';
import { type AsyncResult, useAsyncResult } from './useAsyncResult';

const NO_HOPS: readonly PathHop[] = [];

/**
 * The route's Control Plane Only legs, each judged against its own
 * `eus-4.(E+2)` graph (design/eus.ts). Those graphs load through `client`,
 * cached like any other, after the route is on screen: a leg reads as
 * `checking` until its graph arrives, so the route never waits on them.
 */
export function useControlPlaneOnlyLegs(
  client: GraphClient,
  arch: Arch,
  result: AsyncResult<StitchedPathResult, StitchError>,
): readonly ControlPlaneOnlyLeg[] {
  const hops = result.status === 'success' ? result.value.primary.hops : NO_HOPS;
  const channels = useMemo(() => eusChannelsToCheck(hops), [hops]);
  const key = channels.length > 0 ? `${arch}|${channels.join(',')}` : '';

  const loaded = useAsyncResult(channels.length > 0, key, async (signal) => {
    const graphs = new Map(
      await Promise.all(
        channels.map(async (channel): Promise<[string, EusGraphState]> => {
          const graph = await client.getGraph({ channel, arch }, { signal });
          return [channel, graph.ok ? { kind: 'loaded', graph: graph.value.graph } : { kind: 'failed', error: graph.error }];
        }),
      ),
    );
    return ok({ key, graphs });
  });

  return useMemo(() => {
    // A success for an earlier key (another arch, other legs) stays in state for one render after the key changes.
    const graphs = loaded.status === 'success' && loaded.value.key === key ? loaded.value.graphs : undefined;
    return controlPlaneOnlyLegs(hops, (channel) => graphs?.get(channel) ?? { kind: 'loading' });
  }, [hops, loaded, key]);
}
