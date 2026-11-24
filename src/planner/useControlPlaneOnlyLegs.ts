import { useEffect, useMemo, useState } from 'react';
import { controlPlaneOnlyLegs, type ControlPlaneOnlyLeg, eusChannelsToCheck, type EusGraphState } from '../design/eus';
import type { PathHop, StitchedPathResult, StitchError } from '../engine/types';
import type { GraphClient } from '../graph/client';
import type { Arch } from '../graph/types';
import type { AsyncResult } from './useAsyncResult';

const NO_HOPS: readonly PathHop[] = [];

interface LoadedGraphs {
  /** The arch and channel list these graphs were loaded for. */
  readonly key: string;
  readonly graphs: ReadonlyMap<string, EusGraphState>;
}

/**
 * The route's Control Plane Only legs, each judged against its own
 * `eus-4.(E+2)` graph (design/eus.ts). Those graphs load through `client`,
 * cached like any other, after the route is on screen: a leg reads as
 * `checking` until its own graph arrives, so neither the route nor another
 * leg waits on it.
 */
export function useControlPlaneOnlyLegs(
  client: GraphClient,
  arch: Arch,
  result: AsyncResult<StitchedPathResult, StitchError>,
): readonly ControlPlaneOnlyLeg[] {
  const hops = result.status === 'success' ? result.value.primary.hops : NO_HOPS;
  const channels = useMemo(() => eusChannelsToCheck(hops), [hops]);
  const key = `${arch}|${channels.join(',')}`;
  const [loaded, setLoaded] = useState<LoadedGraphs>({ key: '', graphs: new Map() });

  useEffect(() => {
    const controller = new AbortController();
    for (const channel of channels) {
      void client.getGraph({ channel, arch }, { signal: controller.signal }).then((graph) => {
        if (controller.signal.aborted) return;
        const state: EusGraphState = graph.ok ? { kind: 'loaded', graph: graph.value.graph } : { kind: 'failed', error: graph.error };
        setLoaded((prev) => ({ key, graphs: new Map(prev.key === key ? prev.graphs : []).set(channel, state) }));
      });
    }
    return () => controller.abort();
  }, [client, arch, channels, key]);

  return useMemo(() => {
    // Graphs loaded for an earlier key (another arch, other legs) stay in state until this key's first graph lands.
    const graphs = loaded.key === key ? loaded.graphs : undefined;
    return controlPlaneOnlyLegs(hops, (channel) => graphs?.get(channel) ?? { kind: 'loading' });
  }, [hops, loaded, key]);
}
