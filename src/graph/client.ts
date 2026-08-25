import { LocalStorageGraphCache } from '../cache/localStorageCache';
import { MemoryCache } from '../cache/memoryCache';
import { makeCacheKey, type CacheEntry } from '../cache/types';
import { err, ok, type Result } from '../lib/result';
import type { GraphError } from './errors';
import { parseRawGraph } from './parse';
import type { Arch, Graph } from './types';

const GRAPH_ENDPOINT = import.meta.env.DEV
  ? 'https://api.openshift.com/api/upgrades_info/v1/graph'
  : '/api/graph';

export function buildGraphUrl(channel: string, arch: Arch): string {
  const url = new URL(GRAPH_ENDPOINT, window.location.origin);
  url.searchParams.set('channel', channel);
  url.searchParams.set('arch', arch);
  return url.toString();
}

export interface GraphParams {
  readonly channel: string;
  readonly arch: Arch;
}

export interface FetchGraphOptions {
  /** Skip both cache tiers and go straight to the network -- the manual refresh path. */
  readonly forceRefresh?: boolean;
  readonly signal?: AbortSignal;
}

export interface GraphResult {
  readonly graph: Graph;
  /** Epoch ms the graph was fetched -- surfaced by the UI as "graph fetched at HH:MM". */
  readonly fetchedAt: number;
}

/**
 * Typed client for the Cincinnati update graph endpoint: fetch, validate, and
 * two-tier cache (in-memory Map, then localStorage), per plan.md §1 / §3.
 *
 * `fetchImpl` and `storage` are injectable so tests never touch the network or
 * real browser storage -- see graph/__tests__/client.test.ts.
 */
export class GraphClient {
  private readonly memory = new MemoryCache<Graph>();
  private readonly persistent: LocalStorageGraphCache;
  private readonly fetchImpl: typeof fetch;

  constructor(options?: { readonly storage?: Storage; readonly fetchImpl?: typeof fetch }) {
    this.persistent = new LocalStorageGraphCache(options?.storage);
    this.fetchImpl = options?.fetchImpl ?? fetch.bind(globalThis);
  }

  async getGraph(params: GraphParams, options: FetchGraphOptions = {}): Promise<Result<GraphResult, GraphError>> {
    const key = makeCacheKey(params.channel, params.arch);

    if (!options.forceRefresh) {
      const memHit = this.memory.get(key);
      if (memHit) {
        return ok({ graph: memHit.value, fetchedAt: memHit.fetchedAt });
      }

      const diskHit = this.persistent.get(key);
      if (diskHit) {
        this.memory.set(key, diskHit);
        return ok({ graph: diskHit.value, fetchedAt: diskHit.fetchedAt });
      }
    }

    const fetched = await this.fetchFromNetwork(params, options.signal);
    if (!fetched.ok) {
      return fetched;
    }

    const entry: CacheEntry<Graph> = { value: fetched.value, fetchedAt: Date.now() };
    this.memory.set(key, entry);
    this.persistent.set(key, entry);
    return ok({ graph: entry.value, fetchedAt: entry.fetchedAt });
  }

  /** Manual invalidate/refresh path for one channel/arch pair (both tiers). */
  invalidate(params: GraphParams): void {
    const key = makeCacheKey(params.channel, params.arch);
    this.memory.delete(key);
    this.persistent.invalidate(key);
  }

  /** Manual invalidate/refresh path for the whole cache (both tiers). */
  invalidateAll(): void {
    this.memory.clear();
    this.persistent.clear();
  }

  private async fetchFromNetwork(params: GraphParams, signal: AbortSignal | undefined): Promise<Result<Graph, GraphError>> {
    const url = buildGraphUrl(params.channel, params.arch);

    let response: Response;
    try {
      response = await this.fetchImpl(url, { headers: { Accept: 'application/json' }, signal });
    } catch (e) {
      if (signal?.aborted) {
        return err({ kind: 'aborted' });
      }
      return err({ kind: 'network', message: e instanceof Error ? e.message : String(e) });
    }

    if (!response.ok) {
      // Note: an invalid/unknown channel is NOT reported this way -- Cincinnati
      // returns HTTP 200 with empty arrays for that case (handled as `empty` by
      // parseRawGraph below). A non-2xx here is a genuine transport/server error.
      return err({ kind: 'network', message: response.statusText || `HTTP ${response.status}`, status: response.status });
    }

    let json: unknown;
    try {
      json = await response.json();
    } catch {
      return err({ kind: 'validation', message: 'Response body was not valid JSON.' });
    }

    return parseRawGraph(json, params);
  }
}
