import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { GraphClient } from '../../graph/client';
import { fakeFetch, fakeJsonResponse } from '../../test-utils/fakeFetch';
import { FakeStorage } from '../../test-utils/fakeStorage';
import { usePlanner } from '../usePlanner';

const SEED_CHANNEL = 'stable-4.20';
const SEED_ARCH = 'amd64';

function rawGraphJson(
  versions: readonly string[],
  edges: ReadonlyArray<readonly [number, number]>,
  channelsCsv: string,
): unknown {
  return {
    version: 1,
    nodes: versions.map((version, i) => ({
      version,
      payload: `quay.io/openshift-release-dev/ocp-release@sha256:${i.toString().padStart(64, '0')}`,
      metadata: {
        url: `https://access.redhat.com/errata/TEST-${i}`,
        'io.openshift.upgrades.graph.release.channels': channelsCsv,
      },
    })),
    edges: edges.map(([a, b]) => [a, b]),
    conditionalEdges: [],
  };
}

type Handler = () => Promise<Response>;

function jsonHandler(body: unknown): Handler {
  return () => Promise.resolve(fakeJsonResponse(body));
}

function makeClient(responses: Map<string, Handler>): GraphClient {
  const fetchImpl = fakeFetch(async (url) => {
    const u = new URL(url);
    const channel = u.searchParams.get('channel');
    const arch = u.searchParams.get('arch');
    const key = `${channel}|${arch}`;
    const handler = responses.get(key);
    if (!handler) throw new Error(`no fake response registered for ${key}`);
    return handler();
  });
  return new GraphClient({ storage: new FakeStorage(), fetchImpl });
}

/**
 * The seed channel discovery fetch fires on every `usePlanner` mount -- every
 * test's response map must include it. Only fills in a default seed response
 * when the caller hasn't already registered one for `stable-4.20|amd64`
 * itself (a test whose channel-under-test happens to BE the seed channel
 * supplies its own response, which must win, not be silently overwritten).
 */
function withSeed(responses: Map<string, Handler>, extraChannelsCsv = ''): Map<string, Handler> {
  const key = `${SEED_CHANNEL}|${SEED_ARCH}`;
  if (!responses.has(key)) {
    const csv = ['stable-4.20', 'stable-4.21', 'stable-4.19', extraChannelsCsv].filter(Boolean).join(',');
    responses.set(key, jsonHandler(rawGraphJson(['4.19.0', '4.20.0'], [[0, 1]], csv)));
  }
  return responses;
}

function setUrl(search: string): void {
  window.history.pushState({}, '', `http://localhost:3000/${search}`);
}

afterEach(() => {
  window.history.pushState({}, '', 'http://localhost:3000/');
});

describe('usePlanner — URL restore on load', () => {
  it('restores channel, arch, start and target from the query string and resolves a path', async () => {
    setUrl('?channel=stable-4.20&arch=amd64&start=4.18.2&target=4.20.32');
    const graph = rawGraphJson(['4.18.2', '4.19.40', '4.20.32'], [[0, 1], [1, 2]], 'stable-4.20');
    const client = makeClient(withSeed(new Map([['stable-4.20|amd64', jsonHandler(graph)]])));

    const { result } = renderHook(() => usePlanner(client));

    expect(result.current.channel.value).toBe('stable-4.20');
    expect(result.current.arch.value).toBe('amd64');

    await waitFor(() => expect(result.current.result.status).toBe('success'));
    expect(result.current.start.value).toBe('4.18.2');
    expect(result.current.target.value).toBe('4.20.32');
    expect(result.current.notices).toEqual([]);
    if (result.current.result.status !== 'success') throw new Error('expected success');
    expect(result.current.result.value.primary.versions).toEqual(['4.18.2', '4.19.40', '4.20.32']);
  });

  it('degrades an unrecognised arch param to the default with a visible notice, never a crash', async () => {
    setUrl('?arch=not-a-real-arch');
    const client = makeClient(withSeed(new Map()));

    const { result } = renderHook(() => usePlanner(client));

    expect(result.current.arch.value).toBe('amd64');
    expect(result.current.notices.some((n) => n.includes('not-a-real-arch'))).toBe(true);
  });

  it('a start/target param that names a version absent from the loaded graph degrades to unselected with a notice', async () => {
    setUrl('?channel=stable-4.20&start=9.9.9&target=4.20.32');
    const graph = rawGraphJson(['4.18.2', '4.20.32'], [[0, 1]], 'stable-4.20');
    const client = makeClient(withSeed(new Map([['stable-4.20|amd64', jsonHandler(graph)]])));

    const { result } = renderHook(() => usePlanner(client));

    await waitFor(() => expect(result.current.start.groups.flatMap((g) => g.options).length).toBeGreaterThan(0));
    expect(result.current.notices.some((n) => n.includes('9.9.9') && n.includes('not found'))).toBe(true);
    // Because start never resolved, target resolution is never attempted -- no false "target not found" notice.
    expect(result.current.notices.some((n) => n.includes('4.20.32'))).toBe(false);
  });

  it('a target param older than the start is not offered and gets a notice', async () => {
    setUrl('?channel=stable-4.20&start=4.20.32&target=4.18.2');
    const graph = rawGraphJson(['4.18.2', '4.20.32'], [[0, 1]], 'stable-4.20');
    const client = makeClient(withSeed(new Map([['stable-4.20|amd64', jsonHandler(graph)]])));

    const { result } = renderHook(() => usePlanner(client));

    await waitFor(() => expect(result.current.notices.some((n) => n.includes('4.18.2') && n.includes('not newer'))).toBe(true));
    expect(result.current.target.groups.flatMap((g) => g.options)).toEqual([]);
  });

  it('a target param equal to the start shows only the notice, never a zero-hop route', async () => {
    setUrl('?channel=stable-4.20&start=4.20.32&target=4.20.32');
    const graph = rawGraphJson(['4.18.2', '4.20.32'], [[0, 1]], 'stable-4.20');
    const client = makeClient(withSeed(new Map([['stable-4.20|amd64', jsonHandler(graph)]])));

    const { result } = renderHook(() => usePlanner(client));

    await waitFor(() => expect(result.current.notices.some((n) => n.includes('4.20.32') && n.includes('not newer'))).toBe(true));
    expect(result.current.result.status).toBe('idle');
  });

  it('an unknown/garbage channel param never crashes and surfaces a named fetch error', async () => {
    setUrl('?channel=totally-bogus-channel');
    const client = makeClient(withSeed(new Map([['totally-bogus-channel|amd64', jsonHandler({ nodes: [], edges: [], conditionalEdges: [] })]])));

    const { result } = renderHook(() => usePlanner(client));

    await waitFor(() => expect(result.current.start.error).toBeDefined());
    expect(result.current.start.error).toContain('totally-bogus-channel');
  });
});

describe('usePlanner — cascade invalidation (Q7/Q8)', () => {
  it('changing channel clears start and target', async () => {
    const graphA = rawGraphJson(['4.18.2', '4.19.40'], [[0, 1]], 'chan-a');
    const graphB = rawGraphJson(['4.20.0', '4.21.0'], [[0, 1]], 'chan-b');
    const client = makeClient(
      withSeed(
        new Map([
          ['chan-a|amd64', jsonHandler(graphA)],
          ['chan-b|amd64', jsonHandler(graphB)],
        ]),
      ),
    );

    const { result } = renderHook(() => usePlanner(client));

    act(() => result.current.channel.onChange('chan-a'));
    await waitFor(() => expect(result.current.start.groups.flatMap((g) => g.options).length).toBeGreaterThan(0));
    act(() => result.current.start.onChange('4.18.2'));
    expect(result.current.start.value).toBe('4.18.2');

    act(() => result.current.channel.onChange('chan-b'));
    expect(result.current.start.value).toBe('');
    expect(result.current.target.value).toBe('');

    await waitFor(() => expect(result.current.start.groups.flatMap((g) => g.options)).toContain('4.20.0'));
  });

  it('changing arch clears start and target', async () => {
    const graph = rawGraphJson(['4.18.2', '4.19.40'], [[0, 1]], 'chan-a');
    const client = makeClient(
      withSeed(
        new Map([
          ['chan-a|amd64', jsonHandler(graph)],
          ['chan-a|arm64', jsonHandler(graph)],
        ]),
      ),
    );

    const { result } = renderHook(() => usePlanner(client));
    act(() => result.current.channel.onChange('chan-a'));
    await waitFor(() => expect(result.current.start.groups.flatMap((g) => g.options).length).toBeGreaterThan(0));
    act(() => result.current.start.onChange('4.18.2'));
    expect(result.current.start.value).toBe('4.18.2');

    act(() => result.current.arch.onChange('arm64'));
    expect(result.current.start.value).toBe('');
    expect(result.current.target.value).toBe('');
  });

  it('changing start clears target (its reachable set is keyed on start)', async () => {
    const graph = rawGraphJson(['4.18.2', '4.19.40', '4.20.32'], [[0, 1], [1, 2]], 'chan-a');
    const client = makeClient(withSeed(new Map([['chan-a|amd64', jsonHandler(graph)]])));

    const { result } = renderHook(() => usePlanner(client));
    act(() => result.current.channel.onChange('chan-a'));
    await waitFor(() => expect(result.current.start.groups.flatMap((g) => g.options).length).toBeGreaterThan(0));

    act(() => result.current.start.onChange('4.18.2'));
    await waitFor(() => expect(result.current.target.groups.flatMap((g) => g.options).length).toBeGreaterThan(0));
    act(() => result.current.target.onChange('4.20.32'));
    expect(result.current.target.value).toBe('4.20.32');

    act(() => result.current.start.onChange('4.19.40'));
    expect(result.current.target.value).toBe('');
  });

  it('the target dropdown lists an unreachable version as disabled with a reason, not omitted', async () => {
    // 4.18.2 -> 4.19.40, and a disconnected 4.20.32 with no edge from either.
    const graph = rawGraphJson(['4.18.2', '4.19.40', '4.20.32'], [[0, 1]], 'chan-a');
    const client = makeClient(withSeed(new Map([['chan-a|amd64', jsonHandler(graph)]])));

    const { result } = renderHook(() => usePlanner(client));
    act(() => result.current.channel.onChange('chan-a'));
    await waitFor(() => expect(result.current.start.groups.flatMap((g) => g.options).length).toBeGreaterThan(0));
    act(() => result.current.start.onChange('4.18.2'));

    await waitFor(() => expect(result.current.target.groups.flatMap((g) => g.options).length).toBeGreaterThan(0));
    const unreachable = result.current.target.groups.flatMap((g) => g.options).find((o) => o.version === '4.20.32');
    expect(unreachable).toBeDefined();
    expect(unreachable?.reachable).toBe(false);
  });
});

describe('usePlanner — stale response guarding (Q30)', () => {
  it('a slow first-channel fetch that resolves after the user has already switched channels never clobbers the newer selection', async () => {
    let releaseSlow: (() => void) | undefined;
    const slowHandler: Handler = () =>
      new Promise((resolve) => {
        releaseSlow = () => resolve(fakeJsonResponse(rawGraphJson(['1.0.0'], [], 'chan-slow')));
      });
    const fastGraph = rawGraphJson(['4.20.0', '4.21.0'], [[0, 1]], 'chan-fast');

    const client = makeClient(
      withSeed(
        new Map<string, Handler>([
          ['chan-slow|amd64', slowHandler],
          ['chan-fast|amd64', jsonHandler(fastGraph)],
        ]),
      ),
    );

    const { result } = renderHook(() => usePlanner(client));

    act(() => result.current.channel.onChange('chan-slow'));
    await waitFor(() => expect(releaseSlow).toBeDefined());

    // Switch away before the slow request resolves.
    act(() => result.current.channel.onChange('chan-fast'));
    await waitFor(() => expect(result.current.start.groups.flatMap((g) => g.options)).toContain('4.21.0'));

    // Now let the stale request resolve.
    await act(async () => {
      releaseSlow?.();
      await Promise.resolve();
    });

    // The stale chan-slow response must not have overwritten the current selection's options.
    expect(result.current.channel.value).toBe('chan-fast');
    expect(result.current.start.groups.flatMap((g) => g.options)).toEqual(['4.21.0', '4.20.0']);
  });
});

// plan.md §6 "Look-ahead targets (bidirectional stitching)" -- the scenario
// the user asked for directly: selecting `eus-4.20` (which only spans
// 4.18-4.20) must still offer and resolve a target beyond it (`4.22.9`,
// living only in `eus-4.22`), naming the real channel switch along the way.
describe('usePlanner — look-ahead targets (plan.md §6)', () => {
  it('resolves a permalink target that lives only in a look-ahead channel, and the path stitches across the real channel boundary', async () => {
    setUrl('?channel=eus-4.20&arch=amd64&start=4.18.2&target=4.22.9');

    // Like the live data, the anchor's nodes name the newer channels they are
    // upgrade sources for. eus-4.21 does not exist (EUS is even-minor only).
    const anchor = rawGraphJson(['4.18.2', '4.19.0', '4.20.0'], [[0, 1], [1, 2]], 'eus-4.20,stable-4.21,eus-4.22');
    const eus421Empty = { version: 1, nodes: [], edges: [], conditionalEdges: [] };
    const stable421 = rawGraphJson(['4.20.0', '4.21.0'], [[0, 1]], 'stable-4.21');
    const eus422 = rawGraphJson(['4.20.0', '4.21.0', '4.22.9'], [[0, 1], [1, 2]], 'eus-4.22');

    const client = makeClient(
      withSeed(
        new Map([
          ['eus-4.20|amd64', jsonHandler(anchor)],
          ['eus-4.21|amd64', jsonHandler(eus421Empty)],
          ['stable-4.21|amd64', jsonHandler(stable421)],
          ['eus-4.22|amd64', jsonHandler(eus422)],
        ]),
      ),
    );

    const { result } = renderHook(() => usePlanner(client));

    expect(result.current.channel.value).toBe('eus-4.20');
    await waitFor(() => expect(result.current.result.status).toBe('success'));

    expect(result.current.start.value).toBe('4.18.2');
    expect(result.current.target.value).toBe('4.22.9');
    // No false "not found" notice while look-ahead discovery was still in flight.
    expect(result.current.notices).toEqual([]);

    if (result.current.result.status !== 'success') throw new Error('expected success');
    const { primary, stitch } = result.current.result.value;
    expect(primary.versions).toEqual(['4.18.2', '4.19.0', '4.20.0', '4.21.0', '4.22.9']);
    expect(stitch.multiGraph).toBe(true);
    expect(stitch.channelsUsed).toEqual(['eus-4.20', 'eus-4.22']);

    // The dropdown itself must have offered 4.22.9 as a look-ahead target,
    // clearly marked with the real channel it lives in.
    await waitFor(() => expect(result.current.target.groups.flatMap((g) => g.options).length).toBeGreaterThan(0));
    const lookaheadTarget = result.current.target.groups.flatMap((g) => g.options).find((o) => o.version === '4.22.9');
    expect(lookaheadTarget).toBeDefined();
    expect(lookaheadTarget?.reachable).toBe(true);
    expect(lookaheadTarget?.via?.channel).toBe('eus-4.22');
  });
});

describe('usePlanner — the version grammar', () => {
  it('lists a build-metadata version in both dropdowns and plans a path to it instead of crashing', async () => {
    setUrl('?channel=stable-4.22&start=4.22.0&target=4.22.1%2Bbuild.1');
    const graph = rawGraphJson(['4.22.0', '4.22.1+build.1'], [[0, 1]], 'stable-4.22');
    const client = makeClient(withSeed(new Map([['stable-4.22|amd64', jsonHandler(graph)]])));

    const { result } = renderHook(() => usePlanner(client));

    await waitFor(() => expect(result.current.result.status).toBe('success'));
    expect(result.current.start.groups.map((g) => [g.stream, g.options])).toEqual([['4.22', ['4.22.1+build.1', '4.22.0']]]);
    expect(result.current.target.groups.flatMap((g) => g.options.map((o) => o.version))).toEqual(['4.22.1+build.1']);
    expect(result.current.notices).toEqual([]);
  });

  it('plans a permalink hop to a build of the start release, which ranks equal to it in SemVer', async () => {
    setUrl('?channel=stable-4.22&start=4.22.1-rc.1&target=4.22.1-rc.1%2Bbuild.1');
    const graph = rawGraphJson(['4.22.1-rc.1', '4.22.1-rc.1+build.1'], [[0, 1]], 'stable-4.22');
    const client = makeClient(withSeed(new Map([['stable-4.22|amd64', jsonHandler(graph)]])));

    const { result } = renderHook(() => usePlanner(client));

    await waitFor(() => expect(result.current.result.status).toBe('success'));
    expect(result.current.target.groups.flatMap((g) => g.options.map((o) => o.version))).toEqual(['4.22.1-rc.1+build.1']);
    expect(result.current.notices).toEqual([]);
  });

  it('surfaces a graph with an unparseable version as a channel load error instead of crashing', async () => {
    setUrl('?channel=stable-4.22');
    const graph = rawGraphJson(['4.22'], [], 'stable-4.22');
    const client = makeClient(withSeed(new Map([['stable-4.22|amd64', jsonHandler(graph)]])));

    const { result } = renderHook(() => usePlanner(client));

    await waitFor(() => expect(result.current.start.error).toBeDefined());
    expect(result.current.start.error).toContain('stable-4.22');
    expect(result.current.start.groups).toEqual([]);
  });
});

describe('usePlanner — a stream not yet published outside candidate', () => {
  it('explains an empty stable-5.0 and points at candidate-5.0 instead of failing opaquely', async () => {
    setUrl('?channel=stable-5.0&arch=amd64');
    const empty = { version: 1, nodes: [], edges: [], conditionalEdges: [] };
    const client = makeClient(withSeed(new Map([['stable-5.0|amd64', jsonHandler(empty)]])));

    const { result } = renderHook(() => usePlanner(client));

    await waitFor(() => expect(result.current.start.error).toBeDefined());
    expect(result.current.start.error).toMatch(/stable-5\.0.*no releases published/);
    expect(result.current.start.error).toContain('candidate-5.0');
  });
});
