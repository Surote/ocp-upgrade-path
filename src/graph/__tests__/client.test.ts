import { describe, expect, it, vi } from 'vitest';
import { fakeBrokenJsonResponse, fakeFetch, fakeJsonResponse } from '../../test-utils/fakeFetch';
import { FakeStorage } from '../../test-utils/fakeStorage';
import { loadFixture } from '../../test-utils/fixtures';
import { buildGraphUrl, GraphClient } from '../client';

const PARAMS = { channel: 'stable-4.20', arch: 'amd64' } as const;

function makeClient(fetchImpl: typeof fetch, storage: Storage = new FakeStorage()) {
  return new GraphClient({ fetchImpl, storage });
}

describe('buildGraphUrl', () => {
  it('builds the documented Cincinnati endpoint with channel and arch query params', () => {
    const url = buildGraphUrl('stable-4.20', 'amd64');
    expect(url).toBe('https://api.openshift.com/api/upgrades_info/v1/graph?channel=stable-4.20&arch=amd64');
  });
});

describe('GraphClient — network fetch', () => {
  it('fetches, validates, and returns the graph on success', async () => {
    const fetchImpl = fakeFetch(async () => fakeJsonResponse(loadFixture('stable-4.20.json')));
    const client = makeClient(fetchImpl);

    const result = await client.getGraph(PARAMS);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.graph.nodes).toHaveLength(124);
    expect(typeof result.value.fetchedAt).toBe('number');
  });

  it('sends the Accept: application/json header', async () => {
    const fetchImpl = fakeFetch(async () => fakeJsonResponse(loadFixture('stable-4.21.json')));
    const client = makeClient(fetchImpl);

    await client.getGraph({ channel: 'stable-4.21', arch: 'amd64' });

    expect(fetchImpl).toHaveBeenCalledWith(
      expect.stringContaining('channel=stable-4.21'),
      expect.objectContaining({ headers: { Accept: 'application/json' } }),
    );
  });

  it('reports a non-2xx HTTP response as a network error carrying the status', async () => {
    const fetchImpl = fakeFetch(async () => fakeJsonResponse({}, { ok: false, status: 500, statusText: 'Internal Server Error' }));
    const client = makeClient(fetchImpl);

    const result = await client.getGraph(PARAMS);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('network');
    if (result.error.kind === 'network') expect(result.error.status).toBe(500);
  });

  it('reports a transport failure (fetch rejecting) as a network error', async () => {
    const fetchImpl = fakeFetch(async () => {
      throw new TypeError('Failed to fetch');
    });
    const client = makeClient(fetchImpl);

    const result = await client.getGraph(PARAMS);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('network');
  });

  it('reports a malformed JSON body as a validation error, not a crash', async () => {
    const fetchImpl = fakeFetch(async () => fakeBrokenJsonResponse());
    const client = makeClient(fetchImpl);

    const result = await client.getGraph(PARAMS);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('validation');
  });

  it('treats the HTTP-200-empty-arrays invalid-channel response as `empty`, not success', async () => {
    const fetchImpl = fakeFetch(async () => fakeJsonResponse({ version: 1, nodes: [], edges: [], conditionalEdges: [] }));
    const client = makeClient(fetchImpl);

    const result = await client.getGraph({ channel: 'no-such-channel', arch: 'amd64' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('empty');
  });
});

describe('GraphClient — two-tier caching', () => {
  it('serves a second identical request from the memory tier without refetching', async () => {
    const fetchImpl = fakeFetch(async () => fakeJsonResponse(loadFixture('stable-4.20.json')));
    const client = makeClient(fetchImpl);

    await client.getGraph(PARAMS);
    await client.getGraph(PARAMS);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('an empty-graph result is never cached', async () => {
    const fetchImpl = fakeFetch(async () => fakeJsonResponse({ version: 1, nodes: [], edges: [], conditionalEdges: [] }));
    const client = makeClient(fetchImpl);

    await client.getGraph({ channel: 'no-such-channel', arch: 'amd64' });
    await client.getGraph({ channel: 'no-such-channel', arch: 'amd64' });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('a fresh GraphClient (simulating page reload) still gets a hit from a shared localStorage', async () => {
    const sharedStorage = new FakeStorage();
    const fetchImpl = fakeFetch(async () => fakeJsonResponse(loadFixture('stable-4.20.json')));

    const first = makeClient(fetchImpl, sharedStorage);
    await first.getGraph(PARAMS);

    const second = makeClient(fetchImpl, sharedStorage); // fresh memory tier, same localStorage
    const result = await second.getGraph(PARAMS);

    expect(fetchImpl).toHaveBeenCalledTimes(1); // second client never hit the network
    expect(result.ok).toBe(true);
  });

  it('forceRefresh bypasses both cache tiers', async () => {
    const fetchImpl = fakeFetch(async () => fakeJsonResponse(loadFixture('stable-4.20.json')));
    const client = makeClient(fetchImpl);

    await client.getGraph(PARAMS);
    await client.getGraph(PARAMS, { forceRefresh: true });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('invalidate() forces the next request for that key back to the network', async () => {
    const fetchImpl = fakeFetch(async () => fakeJsonResponse(loadFixture('stable-4.20.json')));
    const client = makeClient(fetchImpl);

    await client.getGraph(PARAMS);
    client.invalidate(PARAMS);
    await client.getGraph(PARAMS);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('invalidateAll() forces every key back to the network', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('stable-4.20')) return fakeJsonResponse(loadFixture('stable-4.20.json'));
      return fakeJsonResponse(loadFixture('stable-4.19.json'));
    }) as unknown as typeof fetch;
    const client = makeClient(fetchImpl);

    await client.getGraph({ channel: 'stable-4.20', arch: 'amd64' });
    await client.getGraph({ channel: 'stable-4.19', arch: 'amd64' });
    client.invalidateAll();
    await client.getGraph({ channel: 'stable-4.20', arch: 'amd64' });
    await client.getGraph({ channel: 'stable-4.19', arch: 'amd64' });

    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it('exposes a stable fetchedAt across cache hits', async () => {
    let now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const fetchImpl = fakeFetch(async () => fakeJsonResponse(loadFixture('stable-4.20.json')));
    const client = makeClient(fetchImpl);

    const first = await client.getGraph(PARAMS);
    now += 60_000; // a minute passes, still well within the 1h TTL
    const second = await client.getGraph(PARAMS);

    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(second.value.fetchedAt).toBe(first.value.fetchedAt);
    }
    vi.restoreAllMocks();
  });
});
