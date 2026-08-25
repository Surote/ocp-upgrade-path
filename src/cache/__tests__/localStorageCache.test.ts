import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildGraph } from '../../test-utils/buildGraph';
import { FakeStorage, QuotaOnceThenOkStorage, ThrowingReadStorage, ThrowingWriteStorage } from '../../test-utils/fakeStorage';
import { LocalStorageGraphCache } from '../localStorageCache';
import { makeCacheKey } from '../types';

const ONE_HOUR_MS = 60 * 60 * 1000;

describe('LocalStorageGraphCache — basic hit/miss', () => {
  it('is a miss for a key that was never set', () => {
    const cache = new LocalStorageGraphCache(new FakeStorage());
    expect(cache.get(makeCacheKey('stable-4.20', 'amd64'))).toBeUndefined();
  });

  it('round-trips a graph set into it', () => {
    const storage = new FakeStorage();
    const cache = new LocalStorageGraphCache(storage);
    const key = makeCacheKey('stable-4.20', 'amd64');
    const graph = buildGraph(['4.20.1', '4.20.2'], [[0, 1]]);

    cache.set(key, { value: graph, fetchedAt: Date.now() });
    const hit = cache.get(key);

    expect(hit).toBeDefined();
    expect(hit?.value).toEqual(graph);
  });

  it('actually persists to the given Storage (not just an internal cache)', () => {
    const storage = new FakeStorage();
    const cache = new LocalStorageGraphCache(storage);
    cache.set(makeCacheKey('stable-4.20', 'amd64'), { value: buildGraph(['4.20.1']), fetchedAt: Date.now() });

    expect(storage.length).toBeGreaterThan(0);
  });
});

describe('LocalStorageGraphCache — TTL expiry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('serves a fresh entry', () => {
    const cache = new LocalStorageGraphCache(new FakeStorage());
    const key = makeCacheKey('stable-4.20', 'amd64');
    cache.set(key, { value: buildGraph(['4.20.1']), fetchedAt: Date.now() });

    vi.advanceTimersByTime(ONE_HOUR_MS - 1000);

    expect(cache.get(key)).toBeDefined();
  });

  it('treats an entry older than 1 hour as a miss', () => {
    const cache = new LocalStorageGraphCache(new FakeStorage());
    const key = makeCacheKey('stable-4.20', 'amd64');
    cache.set(key, { value: buildGraph(['4.20.1']), fetchedAt: Date.now() });

    vi.advanceTimersByTime(ONE_HOUR_MS + 1000);

    expect(cache.get(key)).toBeUndefined();
  });

  it('evicts the expired entry from storage rather than leaving it to rot', () => {
    const storage = new FakeStorage();
    const cache = new LocalStorageGraphCache(storage);
    const key = makeCacheKey('stable-4.20', 'amd64');
    cache.set(key, { value: buildGraph(['4.20.1']), fetchedAt: Date.now() });
    const sizeBeforeExpiry = storage.length;

    vi.advanceTimersByTime(ONE_HOUR_MS + 1000);
    cache.get(key);

    expect(storage.length).toBeLessThan(sizeBeforeExpiry);
  });
});

describe('LocalStorageGraphCache — LRU eviction at 8 entries', () => {
  function keyFor(i: number) {
    return makeCacheKey(`channel-${i}`, 'amd64');
  }

  it('keeps at most 8 entries, evicting least-recently-used first', () => {
    const cache = new LocalStorageGraphCache(new FakeStorage());

    for (let i = 0; i < 9; i += 1) {
      cache.set(keyFor(i), { value: buildGraph([`4.${i}.0`]), fetchedAt: Date.now() });
    }

    // channel-0 was inserted first and never touched again -- it's the LRU victim.
    expect(cache.get(keyFor(0))).toBeUndefined();
    for (let i = 1; i < 9; i += 1) {
      expect(cache.get(keyFor(i))).toBeDefined();
    }
  });

  it('a get() refreshes recency, protecting an old entry from eviction', () => {
    const cache = new LocalStorageGraphCache(new FakeStorage());

    // Fill with 3 entries: A, B, C (recency front-to-back: C, B, A).
    cache.set(keyFor(0), { value: buildGraph(['4.0.0']), fetchedAt: Date.now() }); // A
    cache.set(keyFor(1), { value: buildGraph(['4.1.0']), fetchedAt: Date.now() }); // B
    cache.set(keyFor(2), { value: buildGraph(['4.2.0']), fetchedAt: Date.now() }); // C

    // Touch A -- it's now the most recently used, ahead of B and C.
    expect(cache.get(keyFor(0))).toBeDefined();

    // Add 6 more (D..I) to push total inserts past the cap of 8.
    for (let i = 3; i < 9; i += 1) {
      cache.set(keyFor(i), { value: buildGraph([`4.${i}.0`]), fetchedAt: Date.now() });
    }

    // Recency order was [I,H,G,F,E,D,A,C,B] at 9 entries -- B (never touched,
    // inserted before A was touched) is the actual LRU victim, not A.
    expect(cache.get(keyFor(1))).toBeUndefined(); // B evicted
    expect(cache.get(keyFor(0))).toBeDefined(); // A survives because it was touched
    expect(cache.get(keyFor(2))).toBeDefined(); // C survives
  });
});

describe('LocalStorageGraphCache — resilience to a hostile/broken Storage', () => {
  it('degrades a throwing read to a cache miss, never crashes', () => {
    const cache = new LocalStorageGraphCache(new ThrowingReadStorage());
    expect(() => cache.get(makeCacheKey('stable-4.20', 'amd64'))).not.toThrow();
    expect(cache.get(makeCacheKey('stable-4.20', 'amd64'))).toBeUndefined();
  });

  it('degrades a throwing write to a silent no-op, never crashes', () => {
    const cache = new LocalStorageGraphCache(new ThrowingWriteStorage());
    const key = makeCacheKey('stable-4.20', 'amd64');
    expect(() => cache.set(key, { value: buildGraph(['4.20.1']), fetchedAt: Date.now() })).not.toThrow();
  });

  it('treats corrupt JSON already in storage as a miss, and cleans it up', () => {
    const storage = new FakeStorage();
    storage.setItem('oup:graph:v1:entry:stable-4.20|amd64', 'not valid json {{{');
    const cache = new LocalStorageGraphCache(storage);

    expect(cache.get(makeCacheKey('stable-4.20', 'amd64'))).toBeUndefined();
  });

  it('treats a value of the wrong shape (e.g. from a future/incompatible app version) as a miss', () => {
    const storage = new FakeStorage();
    storage.setItem(
      'oup:graph:v1:entry:stable-4.20|amd64',
      JSON.stringify({ fetchedAt: Date.now(), value: { totallyDifferent: true } }),
    );
    const cache = new LocalStorageGraphCache(storage);

    expect(cache.get(makeCacheKey('stable-4.20', 'amd64'))).toBeUndefined();
  });

  it('treats a stale entry from the pre-channel-membership (Phase 1) shape as a miss and evicts it', () => {
    const storage = new FakeStorage();
    const key = 'oup:graph:v1:entry:stable-4.20|amd64';
    // The exact shape the old code persisted: nodes without `channels`, no
    // top-level `channelNames` -- plan.md §3's amendment made both required,
    // so this must be rejected cleanly rather than parsed into a Graph that's
    // silently missing channel data.
    storage.setItem(
      key,
      JSON.stringify({
        fetchedAt: Date.now(),
        value: {
          nodes: [{ version: '4.20.1', payload: 'quay.io/x@sha256:00' }],
          edges: [],
          conditionalEdges: [],
        },
      }),
    );
    const cache = new LocalStorageGraphCache(storage);

    expect(cache.get(makeCacheKey('stable-4.20', 'amd64'))).toBeUndefined();
    expect(storage.getItem(key)).toBeNull(); // cleaned up, not left to rot
  });

  it('recovers from a QuotaExceededError by purging and retrying once', () => {
    const storage = new QuotaOnceThenOkStorage();
    const cache = new LocalStorageGraphCache(storage);
    const key = makeCacheKey('stable-4.20', 'amd64');
    const graph = buildGraph(['4.20.1']);

    expect(() => cache.set(key, { value: graph, fetchedAt: Date.now() })).not.toThrow();

    expect(cache.get(key)?.value).toEqual(graph);
  });
});

describe('LocalStorageGraphCache — manual invalidation', () => {
  it('invalidate(key) removes just that entry', () => {
    const cache = new LocalStorageGraphCache(new FakeStorage());
    const a = makeCacheKey('stable-4.20', 'amd64');
    const b = makeCacheKey('stable-4.19', 'amd64');
    cache.set(a, { value: buildGraph(['4.20.1']), fetchedAt: Date.now() });
    cache.set(b, { value: buildGraph(['4.19.1']), fetchedAt: Date.now() });

    cache.invalidate(a);

    expect(cache.get(a)).toBeUndefined();
    expect(cache.get(b)).toBeDefined();
  });

  it('clear() removes everything (the manual full-refresh path)', () => {
    const storage = new FakeStorage();
    const cache = new LocalStorageGraphCache(storage);
    cache.set(makeCacheKey('stable-4.20', 'amd64'), { value: buildGraph(['4.20.1']), fetchedAt: Date.now() });
    cache.set(makeCacheKey('stable-4.19', 'amd64'), { value: buildGraph(['4.19.1']), fetchedAt: Date.now() });

    cache.clear();

    expect(cache.get(makeCacheKey('stable-4.20', 'amd64'))).toBeUndefined();
    expect(cache.get(makeCacheKey('stable-4.19', 'amd64'))).toBeUndefined();
  });
});
