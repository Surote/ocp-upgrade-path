import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseRawGraph } from '../../graph/parse';
import { toStorable } from '../../graph/serialize';
import type { Graph } from '../../graph/types';
import { buildGraph } from '../../test-utils/buildGraph';
import { CapacityStorage, FakeStorage, ThrowingReadStorage, ThrowingWriteStorage } from '../../test-utils/fakeStorage';
import { loadFixture } from '../../test-utils/fixtures';
import { LocalStorageGraphCache } from '../localStorageCache';
import { makeCacheKey } from '../types';

const ONE_HOUR_MS = 60 * 60 * 1000;
const ENTRY_PREFIX = 'oup:graph:v3:entry:';

function keyFor(i: number) {
  return makeCacheKey(`channel-${i}`, 'amd64');
}

function entryFor(i: number) {
  return { value: buildGraph([`4.${i}.0`, `4.${i}.1`], [[0, 1]]), fetchedAt: Date.now() };
}

function storedEntryChars(storage: Storage): number {
  for (let i = 0; i < storage.length; i += 1) {
    const key = storage.key(i) as string;
    if (key.startsWith(ENTRY_PREFIX)) return (storage.getItem(key) as string).length;
  }
  throw new Error('no entry stored');
}

/** What the cache stores for a record: gzip of its JSON, base64. */
async function encodeRecord(record: unknown): Promise<string> {
  const gz = await new Response(new Response(JSON.stringify(record)).body?.pipeThrough(new CompressionStream('gzip'))).arrayBuffer();
  return btoa(String.fromCharCode(...new Uint8Array(gz)));
}

describe('LocalStorageGraphCache — basic hit/miss', () => {
  it('is a miss for a key that was never set', async () => {
    const cache = new LocalStorageGraphCache(new FakeStorage());
    expect(await cache.get(makeCacheKey('stable-4.20', 'amd64'))).toBeUndefined();
  });

  it('round-trips a graph set into it', async () => {
    const cache = new LocalStorageGraphCache(new FakeStorage());
    const key = makeCacheKey('stable-4.20', 'amd64');
    const graph = buildGraph(['4.20.1', '4.20.2'], [[0, 1]]);

    const fetchedAt = Date.now() - 1000;
    await cache.set(key, { value: graph, fetchedAt });

    expect(await cache.get(key)).toEqual({ value: graph, fetchedAt });
  });

  it('actually persists to the given Storage, so a fresh cache on the same Storage (a reload) hits', async () => {
    const storage = new FakeStorage();
    const key = makeCacheKey('stable-4.20', 'amd64');
    const graph = buildGraph(['4.20.1']);
    await new LocalStorageGraphCache(storage).set(key, { value: graph, fetchedAt: Date.now() });

    expect((await new LocalStorageGraphCache(storage).get(key))?.value).toEqual(graph);
  });
});

describe('LocalStorageGraphCache — TTL expiry', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('serves a fresh entry', async () => {
    const cache = new LocalStorageGraphCache(new FakeStorage());
    const key = makeCacheKey('stable-4.20', 'amd64');
    await cache.set(key, { value: buildGraph(['4.20.1']), fetchedAt: Date.now() });

    vi.advanceTimersByTime(ONE_HOUR_MS - 1000);

    expect(await cache.get(key)).toBeDefined();
  });

  it('treats an entry older than 1 hour as a miss', async () => {
    const cache = new LocalStorageGraphCache(new FakeStorage());
    const key = makeCacheKey('stable-4.20', 'amd64');
    await cache.set(key, { value: buildGraph(['4.20.1']), fetchedAt: Date.now() });

    vi.advanceTimersByTime(ONE_HOUR_MS + 1000);

    expect(await cache.get(key)).toBeUndefined();
  });

  it('evicts the expired entry from storage rather than leaving it to rot', async () => {
    const storage = new FakeStorage();
    const cache = new LocalStorageGraphCache(storage);
    const key = makeCacheKey('stable-4.20', 'amd64');
    await cache.set(key, { value: buildGraph(['4.20.1']), fetchedAt: Date.now() });
    const sizeBeforeExpiry = storage.length;

    vi.advanceTimersByTime(ONE_HOUR_MS + 1000);
    await cache.get(key);

    expect(storage.length).toBeLessThan(sizeBeforeExpiry);
  });
});

describe('LocalStorageGraphCache — size budget', () => {
  it('keeps every graph a 4.14 route reads (34, each bigger than a real 4.20 graph) across a reload', async () => {
    // A 4.14 anchor's route reads the seed, the anchor and 32-33 look-ahead
    // channels; candidate-4.20 is larger than the average of those graphs.
    const parsed = parseRawGraph(loadFixture('candidate-4.20.json'), { channel: 'candidate-4.20', arch: 'amd64' });
    if (!parsed.ok) throw new Error(parsed.error.kind);
    const storage = new FakeStorage();
    const writer = new LocalStorageGraphCache(storage);
    for (let i = 0; i < 34; i += 1) await writer.set(keyFor(i), { value: parsed.value, fetchedAt: Date.now() });

    const reader = new LocalStorageGraphCache(storage);
    for (let i = 0; i < 34; i += 1) expect((await reader.get(keyFor(i)))?.value, `channel-${i}`).toEqual(parsed.value);
  });

  it('evicts least-recently-used entries once the stored size would pass the budget', async () => {
    const probe = new FakeStorage();
    await new LocalStorageGraphCache(probe).set(keyFor(0), entryFor(0));
    const cache = new LocalStorageGraphCache(new FakeStorage(), { maxStoredChars: storedEntryChars(probe) * 3.5 });

    for (let i = 0; i < 4; i += 1) await cache.set(keyFor(i), entryFor(i));

    expect(await cache.get(keyFor(0))).toBeUndefined();
    for (let i = 1; i < 4; i += 1) expect(await cache.get(keyFor(i))).toBeDefined();
  });

  it('a get() refreshes recency, protecting an old entry from eviction', async () => {
    const probe = new FakeStorage();
    await new LocalStorageGraphCache(probe).set(keyFor(0), entryFor(0));
    const cache = new LocalStorageGraphCache(new FakeStorage(), { maxStoredChars: storedEntryChars(probe) * 3.5 });
    for (let i = 0; i < 3; i += 1) await cache.set(keyFor(i), entryFor(i));

    expect(await cache.get(keyFor(0))).toBeDefined();
    await cache.set(keyFor(3), entryFor(3));

    expect(await cache.get(keyFor(1))).toBeUndefined();
    expect(await cache.get(keyFor(0))).toBeDefined();
    expect(await cache.get(keyFor(2))).toBeDefined();
  });

  it('skips a graph bigger than the whole budget instead of evicting everything for it', async () => {
    const probe = new FakeStorage();
    await new LocalStorageGraphCache(probe).set(keyFor(0), entryFor(0));
    const cache = new LocalStorageGraphCache(new FakeStorage(), { maxStoredChars: storedEntryChars(probe) * 1.5 });
    await cache.set(keyFor(0), entryFor(0));

    const big = buildGraph(Array.from({ length: 200 }, (_, i) => `4.99.${i}`));
    await cache.set(keyFor(1), { value: big, fetchedAt: Date.now() });

    expect(await cache.get(keyFor(1))).toBeUndefined();
    expect(await cache.get(keyFor(0))).toBeDefined();
  });
});

describe('LocalStorageGraphCache — resilience to a hostile/broken Storage', () => {
  it('degrades a throwing read to a cache miss, never rejects', async () => {
    const cache = new LocalStorageGraphCache(new ThrowingReadStorage());
    await expect(cache.get(makeCacheKey('stable-4.20', 'amd64'))).resolves.toBeUndefined();
  });

  it('degrades a throwing write to a silent no-op, never rejects', async () => {
    const cache = new LocalStorageGraphCache(new ThrowingWriteStorage());
    await expect(cache.set(makeCacheKey('stable-4.20', 'amd64'), entryFor(0))).resolves.toBeUndefined();
  });

  it('treats undecodable data already in storage as a miss, and cleans it up', async () => {
    const storage = new FakeStorage();
    const key = `${ENTRY_PREFIX}stable-4.20|amd64`;
    storage.setItem(key, 'not valid base64 gzip {{{');
    storage.setItem('oup:graph:v3:manifest', JSON.stringify([['stable-4.20|amd64', 25]]));
    const cache = new LocalStorageGraphCache(storage);

    expect(await cache.get(makeCacheKey('stable-4.20', 'amd64'))).toBeUndefined();
    expect(storage.getItem(key)).toBeNull();
  });

  it('treats a decodable record of the wrong shape (a phase-1 graph without channel membership) as a miss, and cleans it up', async () => {
    const storage = new FakeStorage();
    const key = `${ENTRY_PREFIX}stable-4.20|amd64`;
    const encoded = await encodeRecord({
      fetchedAt: Date.now(),
      value: { nodes: [{ version: '4.20.1', payload: 'quay.io/x@sha256:00' }], edges: [], conditionalEdges: [] },
    });
    storage.setItem(key, encoded);
    storage.setItem('oup:graph:v3:manifest', JSON.stringify([['stable-4.20|amd64', encoded.length]]));
    const cache = new LocalStorageGraphCache(storage);

    expect(await cache.get(makeCacheKey('stable-4.20', 'amd64'))).toBeUndefined();
    expect(storage.getItem(key)).toBeNull();
  });

  it('when storage runs out of room before the budget, evicts least-recently-used entries until the write fits', async () => {
    const probe = new FakeStorage();
    await new LocalStorageGraphCache(probe).set(keyFor(0), entryFor(0));
    const storage = new CapacityStorage(storedEntryChars(probe) * 3.5);
    const cache = new LocalStorageGraphCache(storage);

    for (let i = 0; i < 6; i += 1) await expect(cache.set(keyFor(i), entryFor(i))).resolves.toBeUndefined();

    expect(await cache.get(keyFor(5))).toBeDefined();
    expect(await cache.get(keyFor(4))).toBeDefined();
    expect(await cache.get(keyFor(0))).toBeUndefined();
  });

  it('gives up quietly when even an empty cache has no room, leaving no partial entry behind', async () => {
    const storage = new CapacityStorage(50);
    const cache = new LocalStorageGraphCache(storage);

    await expect(cache.set(keyFor(0), entryFor(0))).resolves.toBeUndefined();

    expect(await cache.get(keyFor(0))).toBeUndefined();
    expect(storage.usedChars()).toBeLessThanOrEqual(50);
    expect(storage.getItem(`${ENTRY_PREFIX}${keyFor(0)}`)).toBeNull();
  });
});

describe('LocalStorageGraphCache — keys it does not own', () => {
  function seed(storage: Storage, version: 'v1' | 'v2', graph: Graph) {
    storage.setItem(`oup:graph:${version}:entry:stable-4.20|amd64`, JSON.stringify({ fetchedAt: Date.now(), value: toStorable(graph) }));
    storage.setItem(`oup:graph:${version}:manifest`, JSON.stringify(['stable-4.20|amd64']));
  }

  it('does not serve, and removes, entries of earlier formats while leaving unrelated keys alone', async () => {
    const storage = new FakeStorage();
    seed(storage, 'v1', buildGraph(['4.20.1']));
    seed(storage, 'v2', buildGraph(['4.20.1']));
    storage.setItem('oup:channels:v1', 'keep');
    storage.setItem('someone-else', 'keep');
    const cache = new LocalStorageGraphCache(storage);

    expect(await cache.get(makeCacheKey('stable-4.20', 'amd64'))).toBeUndefined();
    expect([...Array(storage.length).keys()].map((i) => storage.key(i)).sort()).toEqual(['oup:channels:v1', 'someone-else']);
  });

  it('removes an entry the manifest does not list, as a write cut short leaves', async () => {
    const storage = new FakeStorage();
    await new LocalStorageGraphCache(storage).set(keyFor(0), entryFor(0));
    storage.setItem(`${ENTRY_PREFIX}orphan|amd64`, 'x'.repeat(100));

    new LocalStorageGraphCache(storage);

    expect(storage.getItem(`${ENTRY_PREFIX}orphan|amd64`)).toBeNull();
    expect(storage.getItem(`${ENTRY_PREFIX}${keyFor(0)}`)).not.toBeNull();
  });
});

describe('LocalStorageGraphCache — manual invalidation', () => {
  it('invalidate(key) removes just that entry', async () => {
    const cache = new LocalStorageGraphCache(new FakeStorage());
    const a = makeCacheKey('stable-4.20', 'amd64');
    const b = makeCacheKey('stable-4.19', 'amd64');
    await cache.set(a, { value: buildGraph(['4.20.1']), fetchedAt: Date.now() });
    await cache.set(b, { value: buildGraph(['4.19.1']), fetchedAt: Date.now() });

    cache.invalidate(a);

    expect(await cache.get(a)).toBeUndefined();
    expect(await cache.get(b)).toBeDefined();
  });

  it('clear() removes everything (the manual full-refresh path)', async () => {
    const storage = new FakeStorage();
    const cache = new LocalStorageGraphCache(storage);
    await cache.set(makeCacheKey('stable-4.20', 'amd64'), { value: buildGraph(['4.20.1']), fetchedAt: Date.now() });
    await cache.set(makeCacheKey('stable-4.19', 'amd64'), { value: buildGraph(['4.19.1']), fetchedAt: Date.now() });

    cache.clear();

    expect(storage.length).toBe(0);
  });
});
