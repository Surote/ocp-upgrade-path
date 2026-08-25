/** Cache key for a graph, always `${channel}|${arch}` -- branded so a raw
 * channel or arch string can't be passed where a composed key is expected. */
export type CacheKey = string & { readonly __brand: 'CacheKey' };

export function makeCacheKey(channel: string, arch: string): CacheKey {
  return `${channel}|${arch}` as CacheKey;
}

export interface CacheEntry<T> {
  readonly value: T;
  /** Epoch ms when this graph was fetched from the network -- surfaced to the UI
   * (Phase 4) as "graph fetched at HH:MM" so nobody plans an upgrade against a
   * stale cached graph without knowing it. */
  readonly fetchedAt: number;
}
