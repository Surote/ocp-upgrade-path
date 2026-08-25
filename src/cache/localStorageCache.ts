import { parseTrimmedGraph } from '../graph/parse';
import { toStorable } from '../graph/serialize';
import type { Graph } from '../graph/types';
import type { CacheEntry, CacheKey } from './types';

const PREFIX = 'oup:graph:v1:';
const MANIFEST_KEY = `${PREFIX}manifest`;
const TTL_MS = 60 * 60 * 1000; // 1 hour, per plan.md §3
const MAX_ENTRIES = 8; // LRU cap, per plan.md §3 (~1.75 MB of trimmed graphs)

function entryKey(key: CacheKey): string {
  return `${PREFIX}entry:${key}`;
}

function isQuotaExceededError(e: unknown): boolean {
  if (!(e instanceof DOMException)) return false;
  return (
    e.name === 'QuotaExceededError' ||
    e.name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
    e.code === 22 ||
    e.code === 1014
  );
}

interface StoredRecord {
  readonly fetchedAt: number;
  readonly value: unknown;
}

function isStoredRecordShape(value: unknown): value is StoredRecord {
  return (
    typeof value === 'object' &&
    value !== null &&
    'fetchedAt' in value &&
    'value' in value &&
    typeof (value as { fetchedAt: unknown }).fetchedAt === 'number'
  );
}

/**
 * Cache tier 2: localStorage, 1-hour TTL, LRU-capped at 8 entries, storing the
 * trimmed Graph shape (not the raw API response) -- per plan.md §3.
 *
 * Every read and write is wrapped in try/catch. localStorage throws outright in
 * some contexts (private browsing, disabled site data) and can hold corrupt or
 * foreign data even when it doesn't throw -- another tab, a previous app
 * version's shape, or manual tampering. Any failure here degrades to "treat as
 * a cache miss" (get) or "silently drop the write" (set); it never throws out
 * of this class, so the graph client can always fall back to the network.
 */
export class LocalStorageGraphCache {
  private readonly storage: Storage;

  constructor(storage: Storage = globalThis.localStorage) {
    this.storage = storage;
  }

  get(key: CacheKey): CacheEntry<Graph> | undefined {
    try {
      const raw = this.storage.getItem(entryKey(key));
      if (raw == null) return undefined;

      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(raw);
      } catch {
        this.removeEntry(key);
        return undefined;
      }

      if (!isStoredRecordShape(parsedJson)) {
        this.removeEntry(key);
        return undefined;
      }

      const { fetchedAt, value } = parsedJson;
      if (Date.now() - fetchedAt > TTL_MS) {
        this.removeEntry(key);
        return undefined;
      }

      const parsed = parseTrimmedGraph(value);
      if (!parsed.ok) {
        this.removeEntry(key);
        return undefined;
      }

      this.touch(key);
      return { value: parsed.value, fetchedAt };
    } catch {
      return undefined;
    }
  }

  set(key: CacheKey, entry: CacheEntry<Graph>): void {
    const record: StoredRecord = { fetchedAt: entry.fetchedAt, value: toStorable(entry.value) };
    const serialized = JSON.stringify(record);
    try {
      this.writeEntry(key, serialized);
    } catch (e) {
      if (!isQuotaExceededError(e)) return; // any other failure: give up silently, memory tier still has it
      try {
        this.purge();
        this.writeEntry(key, serialized);
      } catch {
        // Still failing after a full purge -- give up silently. The in-memory
        // tier still has this graph for the rest of the session.
      }
    }
  }

  /** Manual invalidate/refresh path for one entry. */
  invalidate(key: CacheKey): void {
    try {
      this.removeEntry(key);
    } catch {
      // ignore
    }
  }

  /** Manual invalidate/refresh path for the whole cache. */
  clear(): void {
    try {
      this.purge();
    } catch {
      // ignore
    }
  }

  private writeEntry(key: CacheKey, serialized: string): void {
    this.storage.setItem(entryKey(key), serialized);
    const manifest = this.readManifest().filter((k) => k !== key);
    manifest.unshift(key);
    while (manifest.length > MAX_ENTRIES) {
      const evicted = manifest.pop();
      if (evicted !== undefined) {
        this.storage.removeItem(entryKey(evicted));
      }
    }
    this.writeManifest(manifest);
  }

  private touch(key: CacheKey): void {
    try {
      const manifest = this.readManifest().filter((k) => k !== key);
      manifest.unshift(key);
      this.writeManifest(manifest);
    } catch {
      // Recency bookkeeping is best-effort; losing it degrades eviction
      // ordering on a future write, not correctness of this read.
    }
  }

  private removeEntry(key: CacheKey): void {
    try {
      this.storage.removeItem(entryKey(key));
      const manifest = this.readManifest().filter((k) => k !== key);
      this.writeManifest(manifest);
    } catch {
      // ignore
    }
  }

  private purge(): void {
    for (const key of this.readManifest()) {
      this.storage.removeItem(entryKey(key));
    }
    this.storage.removeItem(MANIFEST_KEY);
  }

  private readManifest(): CacheKey[] {
    try {
      const raw = this.storage.getItem(MANIFEST_KEY);
      if (raw == null) return [];
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((v): v is CacheKey => typeof v === 'string');
    } catch {
      return [];
    }
  }

  private writeManifest(manifest: readonly CacheKey[]): void {
    this.storage.setItem(MANIFEST_KEY, JSON.stringify(manifest));
  }
}
