import { describe, expect, it } from 'vitest';
import { buildGraph } from '../../test-utils/buildGraph';
import type { Graph } from '../../graph/types';
import { MemoryCache } from '../memoryCache';
import { makeCacheKey } from '../types';

describe('MemoryCache', () => {
  it('is a miss for a key that was never set', () => {
    const cache = new MemoryCache<Graph>();
    expect(cache.get(makeCacheKey('stable-4.20', 'amd64'))).toBeUndefined();
  });

  it('returns exactly what was set, including fetchedAt', () => {
    const cache = new MemoryCache<Graph>();
    const key = makeCacheKey('stable-4.20', 'amd64');
    const graph = buildGraph(['4.20.1', '4.20.2']);
    cache.set(key, { value: graph, fetchedAt: 12345 });

    const hit = cache.get(key);
    expect(hit?.value).toBe(graph);
    expect(hit?.fetchedAt).toBe(12345);
  });

  it('keys entries by the full channel|arch pair, not just channel', () => {
    const cache = new MemoryCache<Graph>();
    const amd64 = buildGraph(['4.20.1']);
    const arm64 = buildGraph(['4.20.2']);
    cache.set(makeCacheKey('stable-4.20', 'amd64'), { value: amd64, fetchedAt: 1 });
    cache.set(makeCacheKey('stable-4.20', 'arm64'), { value: arm64, fetchedAt: 2 });

    expect(cache.get(makeCacheKey('stable-4.20', 'amd64'))?.value).toBe(amd64);
    expect(cache.get(makeCacheKey('stable-4.20', 'arm64'))?.value).toBe(arm64);
  });

  it('delete removes only the given key', () => {
    const cache = new MemoryCache<Graph>();
    const a = makeCacheKey('stable-4.20', 'amd64');
    const b = makeCacheKey('stable-4.19', 'amd64');
    cache.set(a, { value: buildGraph(['4.20.1']), fetchedAt: 1 });
    cache.set(b, { value: buildGraph(['4.19.1']), fetchedAt: 1 });

    cache.delete(a);

    expect(cache.get(a)).toBeUndefined();
    expect(cache.get(b)).toBeDefined();
  });

  it('clear removes everything', () => {
    const cache = new MemoryCache<Graph>();
    cache.set(makeCacheKey('stable-4.20', 'amd64'), { value: buildGraph(['4.20.1']), fetchedAt: 1 });
    cache.set(makeCacheKey('stable-4.19', 'amd64'), { value: buildGraph(['4.19.1']), fetchedAt: 1 });

    cache.clear();

    expect(cache.get(makeCacheKey('stable-4.20', 'amd64'))).toBeUndefined();
    expect(cache.get(makeCacheKey('stable-4.19', 'amd64'))).toBeUndefined();
  });
});
