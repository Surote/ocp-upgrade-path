import { renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
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

/** A found route over `routeHops`; each call builds fresh objects, as a rerank does. */
function found(routeHops: readonly PathHop[]): AsyncResult<StitchedPathResult, StitchError> {
  const versions = routeHops.length ? [routeHops[0]?.from, ...routeHops.map((hop) => hop.to)] : [];
  return {
    status: 'success',
    value: { primary: { versions, hops: routeHops, cost: { hops: routeHops.length, riskWeight: 0, tieBreak: 0 }, riskSummary: [] } } as unknown as StitchedPathResult,
    retry: () => {},
  } as AsyncResult<StitchedPathResult, StitchError>;
}

const result = found(hops);

/** Resolvable by hand: `respond` answers the request `fetchImpl` is waiting on. */
function deferred() {
  let respond: (response: Response) => void = () => {};
  const promise = new Promise<Response>((resolve) => (respond = resolve));
  return { promise, respond };
}

const legKinds = (legs: readonly { readonly eusChannel: string; readonly kind: string }[]) => legs.map((leg) => `${leg.eusChannel} ${leg.kind}`);

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

  it("shows a leg as checking while its graph reloads after a failure, not the failed run's verdict", async () => {
    const eus418 = [fakeJsonResponse({}, { ok: false, status: 502, statusText: 'Bad Gateway' })];
    const retry = deferred();
    const fetchImpl = fakeFetch(async (url) => {
      const channel = new URL(url).searchParams.get('channel');
      if (channel === 'eus-4.18') return eus418.shift() ?? retry.promise;
      return fakeJsonResponse(chain(VERSIONS.slice(2)));
    });
    const client = new GraphClient({ storage: new FakeStorage(), fetchImpl });
    const { result: legs, rerender } = renderHook(({ route }) => useControlPlaneOnlyLegs(client, 'amd64', route), { initialProps: { route: result } });
    await waitFor(() => expect(legKinds(legs.current)).toEqual(['eus-4.18 unavailable', 'eus-4.20 available']));

    rerender({ route: found(hops.slice(0, 1)) });
    rerender({ route: found([...hops]) });

    expect(legKinds(legs.current)).toEqual(['eus-4.18 checking', 'eus-4.20 checking']);
    await waitFor(() => expect(legKinds(legs.current)).toEqual(['eus-4.18 checking', 'eus-4.20 available']));
    retry.respond(fakeJsonResponse(chain(VERSIONS.slice(0, 3))));
    await waitFor(() => expect(legKinds(legs.current)).toEqual(['eus-4.18 available', 'eus-4.20 available']));
  });

  it('keeps a slow leg\'s request when a rerank returns the same legs in a new route object', async () => {
    const eus420 = deferred();
    const fetchImpl = fakeFetch(async (url) => {
      const channel = new URL(url).searchParams.get('channel');
      if (channel === 'eus-4.20') return eus420.promise;
      return fakeJsonResponse(chain(VERSIONS.slice(0, 3)));
    });
    const client = new GraphClient({ storage: new FakeStorage(), fetchImpl });
    const { result: legs, rerender } = renderHook(({ route }) => useControlPlaneOnlyLegs(client, 'amd64', route), { initialProps: { route: result } });
    await waitFor(() => expect(legKinds(legs.current)).toEqual(['eus-4.18 available', 'eus-4.20 checking']));

    rerender({ route: found(hops.map((hop) => ({ ...hop }))) });
    eus420.respond(fakeJsonResponse(chain(VERSIONS.slice(2))));

    await waitFor(() => expect(legKinds(legs.current)).toEqual(['eus-4.18 available', 'eus-4.20 available']));
    expect(vi.mocked(fetchImpl).mock.calls.filter(([url]) => String(url).includes('channel=eus-4.20'))).toHaveLength(1);
  });
});
