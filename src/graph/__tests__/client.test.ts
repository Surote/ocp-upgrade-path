import { afterEach, describe, expect, it, vi } from 'vitest';
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

/**
 * Holds each of the first `count` gzip streams of `name` constructed after
 * this call until its `release`, so a cache read or write is still pending
 * while a refresh runs. Later streams run freely.
 */
function holdStreams(name: 'CompressionStream' | 'DecompressionStream', count: number) {
  const Real = globalThis[name];
  const gates = Array.from({ length: count }, () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => (markStarted = resolve));
    return { gate, release, started, markStarted };
  });
  let constructed = 0;
  class Held {
    readonly writable: WritableStream;
    readonly readable: ReadableStream;
    constructor(format: CompressionFormat) {
      const real = new Real(format);
      const held = gates[constructed++];
      this.writable = real.writable;
      this.readable = held ? real.readable.pipeThrough(new TransformStream({ start: () => held.gate })) : real.readable;
      held?.markStarted();
    }
  }
  vi.stubGlobal(name, Held);
  return gates.map(({ release, started }) => ({ release, started }));
}

function holdFirstStream(name: 'CompressionStream' | 'DecompressionStream') {
  return holdStreams(name, 1)[0] as { release: () => void; started: Promise<void> };
}

describe('GraphClient — a refresh is never undone by an older cache operation', () => {
  afterEach(() => vi.unstubAllGlobals());

  const OLD_NODES = 124;

  function sequenceFetch(...fixtures: string[]) {
    let call = 0;
    return fakeFetch(async () => fakeJsonResponse(loadFixture(fixtures[Math.min(call++, fixtures.length - 1)] as string)));
  }

  it('a disk read that finishes after a refresh does not replace the refreshed graph', async () => {
    const storage = new FakeStorage();
    await makeClient(sequenceFetch('stable-4.20.json'), storage).getGraph(PARAMS);
    const client = makeClient(sequenceFetch('stable-4.19.json'), storage);
    const disk = holdFirstStream('DecompressionStream');

    const staleRead = client.getGraph(PARAMS);
    await disk.started;
    client.invalidate(PARAMS);
    const refreshed = await client.getGraph(PARAMS);
    disk.release();
    await staleRead;

    const after = await client.getGraph(PARAMS);
    expect(refreshed.ok && refreshed.value.graph.nodes.length).not.toBe(OLD_NODES);
    expect(after.ok && after.value.graph.nodes.length).toBe(refreshed.ok && refreshed.value.graph.nodes.length);
  });

  it('a disk write still compressing when the entry is refreshed does not land after the refresh', async () => {
    const storage = new FakeStorage();
    const client = makeClient(sequenceFetch('stable-4.20.json', 'stable-4.19.json'), storage);
    const write = holdFirstStream('CompressionStream');

    const firstLoad = client.getGraph(PARAMS);
    await write.started;
    client.invalidate(PARAMS);
    const refreshed = await client.getGraph(PARAMS);
    write.release();
    await firstLoad;

    const reloaded = await makeClient(sequenceFetch('stable-4.21.json'), storage).getGraph(PARAMS);
    expect(refreshed.ok && refreshed.value.graph.nodes.length).not.toBe(OLD_NODES);
    expect(reloaded.ok && reloaded.value.graph.nodes.length).toBe(refreshed.ok && refreshed.value.graph.nodes.length);
  });

  it('a disk read retried after a forced refresh began does not put the old graph back', async () => {
    const storage = new FakeStorage();
    await makeClient(sequenceFetch('stable-4.20.json'), storage).getGraph(PARAMS);
    let openNetwork!: () => void;
    const network = new Promise<void>((resolve) => (openNetwork = resolve));
    let fetches = 0;
    let markRetriedOnNetwork!: () => void;
    const retriedOnNetwork = new Promise<void>((resolve) => (markRetriedOnNetwork = resolve));
    const fetchImpl = fakeFetch(async () => {
      if (++fetches === 2) markRetriedOnNetwork();
      await network;
      return fakeJsonResponse(loadFixture('stable-4.19.json'));
    });
    const client = makeClient(fetchImpl, storage);
    const [firstRead, retriedRead] = holdStreams('DecompressionStream', 2) as [
      { release: () => void; started: Promise<void> },
      { release: () => void; started: Promise<void> },
    ];

    const staleRead = client.getGraph(PARAMS);
    await firstRead.started;
    const refresh = client.getGraph(PARAMS, { forceRefresh: true });
    firstRead.release();
    await Promise.race([retriedRead.started, retriedOnNetwork]);
    openNetwork();
    const refreshed = await refresh;
    retriedRead.release();
    await staleRead;

    const after = await client.getGraph(PARAMS);
    expect(refreshed.ok && refreshed.value.graph.nodes.length).not.toBe(OLD_NODES);
    expect(after.ok && after.value.graph.nodes.length).toBe(refreshed.ok && refreshed.value.graph.nodes.length);
  });
});
