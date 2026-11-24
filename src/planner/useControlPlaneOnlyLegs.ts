import { useEffect, useMemo, useState } from 'react';
import { controlPlaneOnlyLegs, type ControlPlaneOnlyLeg, eusChannelsToCheck, type EusGraphState } from '../design/eus';
import type { PathHop, StitchedPathResult, StitchError } from '../engine/types';
import type { GraphClient } from '../graph/client';
import type { Arch, Graph } from '../graph/types';
import type { AsyncResult } from './useAsyncResult';

const NO_HOPS: readonly PathHop[] = [];

/** One verification of a route's legs: the EUS channels to load, for one arch. */
interface Run {
  readonly client: GraphClient;
  readonly arch: Arch;
  readonly channels: readonly string[];
}

interface RunResults {
  readonly run: Run | undefined;
  readonly graphs: ReadonlyMap<string, EusGraphState>;
}

export interface ControlPlaneOnlyCheck {
  readonly legs: readonly ControlPlaneOnlyLeg[];
  /** The EUS graphs the current run has loaded so far. */
  readonly graphs: readonly Graph[];
}

/**
 * The route's Control Plane Only legs, each judged against its own
 * `eus-4.(E+2)` graph (design/eus.ts). Those graphs load through `client`,
 * cached like any other, after the route is on screen: a leg reads as
 * `checking` until its own graph arrives in the current run, so neither the
 * route nor another leg waits on it, and no earlier run's verdict shows.
 */
export function useControlPlaneOnlyLegs(
  client: GraphClient,
  arch: Arch,
  result: AsyncResult<StitchedPathResult, StitchError>,
): ControlPlaneOnlyCheck {
  const hops = result.status === 'success' ? result.value.primary.hops : NO_HOPS;
  const channelsKey = eusChannelsToCheck(hops).join(',');
  // A rerank yields new hops with the same legs; only new channel values start a new run.
  const run = useMemo<Run>(() => ({ client, arch, channels: channelsKey ? channelsKey.split(',') : [] }), [client, arch, channelsKey]);
  const [results, setResults] = useState<RunResults>({ run: undefined, graphs: new Map() });

  useEffect(() => {
    const controller = new AbortController();
    for (const channel of run.channels) {
      void run.client.getGraph({ channel, arch: run.arch }, { signal: controller.signal }).then((graph) => {
        if (controller.signal.aborted) return;
        const state: EusGraphState = graph.ok ? { kind: 'loaded', graph: graph.value.graph } : { kind: 'failed', error: graph.error };
        setResults((prev) => ({ run, graphs: new Map(prev.run === run ? prev.graphs : []).set(channel, state) }));
      });
    }
    return () => controller.abort();
  }, [run]);

  return useMemo(() => {
    const graphs = results.run === run ? results.graphs : undefined;
    return {
      legs: controlPlaneOnlyLegs(hops, (channel) => graphs?.get(channel) ?? { kind: 'loading' }),
      graphs: [...(graphs?.values() ?? [])].flatMap((state) => (state.kind === 'loaded' ? [state.graph] : [])),
    };
  }, [hops, results, run]);
}
