import type { CacheEntry, CacheKey } from './types';

/**
 * Cache tier 1: a plain in-memory Map, scoped to the page session.
 *
 * Per plan.md §3, only the localStorage tier (tier 2) is specified with a
 * 1-hour TTL and an 8-entry LRU cap -- this tier is deliberately just a Map with
 * no eviction policy of its own. It resets naturally on reload, and every entry
 * still carries the `fetchedAt` it was stored with, so "graph fetched at HH:MM"
 * stays accurate for a long-lived tab even though this tier never expires an
 * entry on its own.
 */
export class MemoryCache<T> {
  private readonly map = new Map<CacheKey, CacheEntry<T>>();

  get(key: CacheKey): CacheEntry<T> | undefined {
    return this.map.get(key);
  }

  set(key: CacheKey, entry: CacheEntry<T>): void {
    this.map.set(key, entry);
  }

  delete(key: CacheKey): void {
    this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }
}
