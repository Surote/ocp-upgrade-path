import { renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { PathHop, StitchedPathResult, StitchError } from '../../engine/types';
import { GraphClient } from '../../graph/client';
import type { Version } from '../../graph/types';
import { fakeFetch, fakeJsonResponse } from '../../test-utils/fakeFetch';
import { FakeStorage } from '../../test-utils/fakeStorage';
import type { AsyncResult } from '../useAsyncResult';
import { useControlPlaneOnlyLegs } from '../useControlPlaneOnlyLegs';

const VERSIONS = ['4.16.1', '4.17.1', '4.18.1', '4.19.1', '4.20.1'];
const hops: PathHop[] = VERSIONS.slice(1).map((to, i) => ({
  from: VERSIONS[i] as Version,
  to: to as Version,
  risks: [],
  sourceChannel: 'stable-4.20',
}));

/** A raw Cincinnati graph publishing `versions` as one chain. */
function chain(versions: readonly string[]) {
  return {
    version: 1,
    nodes: versions.map((version) => ({ version, payload: `quay.io/openshift-release-dev/ocp-release@sha256:${'a'.repeat(64)}` })),
    edges: versions.slice(1).map((_, i) => [i, i + 1]),
    conditionalEdges: [],
  };
}

const result = {
  status: 'success',
  value: { primary: { versions: VERSIONS, hops, cost: { hops: 4, riskWeight: 0, tieBreak: 0 }, riskSummary: [] } } as unknown as StitchedPathResult,
  retry: () => {},
} as AsyncResult<StitchedPathResult, StitchError>;

describe('useControlPlaneOnlyLegs', () => {
  it("settles each leg when its own EUS graph arrives, not when the slowest one does", async () => {
    const fetchImpl = fakeFetch(async (url) => {
      const channel = new URL(url).searchParams.get('channel');
      if (channel === 'eus-4.18') return fakeJsonResponse(chain(VERSIONS.slice(0, 3)));
      return new Promise<Response>(() => {});
    });
    const client = new GraphClient({ storage: new FakeStorage(), fetchImpl });

    const { result: legs } = renderHook(() => useControlPlaneOnlyLegs(client, 'amd64', result));

    await waitFor(() => expect(legs.current.map((leg) => `${leg.eusChannel} ${leg.kind}`)).toEqual(['eus-4.18 available', 'eus-4.20 checking']));
  });
});
