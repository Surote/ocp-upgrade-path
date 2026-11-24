import { parseTrimmedGraph } from '../graph/parse';
import { toStorable } from '../graph/serialize';
import type { Graph } from '../graph/types';
import type { CacheEntry, CacheKey } from './types';

// v3: entries are gzip-compressed (v2 stored plain JSON, v1 predates
// traversable conditional edges). Keys of any other version are removed.
const OWN_PREFIX = 'oup:graph:';
const PREFIX = `${OWN_PREFIX}v3:`;
const MANIFEST_KEY = `${PREFIX}manifest`;
const TTL_MS = 60 * 60 * 1000; // 1 hour, per plan.md §3

/**
 * Characters all entries may occupy. A 4.14 anchor's route reads about 34
 * graphs: 7.0M characters as plain JSON, more than any browser lets one origin
 * keep, and about 1.6M compressed. Safari counts the quota as 5 MB of UTF-16,
 * about 2.6M characters, so this leaves room for the rest of the origin.
 */
const MAX_STORED_CHARS = 2_000_000;

/** Most recently used first, with each entry's stored length. */
type Manifest = Array<readonly [CacheKey, number]>;

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

async function gzipBase64(text: string): Promise<string> {
  const stream = new Response(text).body?.pipeThrough(new CompressionStream('gzip'));
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

async function gunzipBase64(encoded: string): Promise<string> {
  const bytes = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0));
  return new Response(new Response(bytes).body?.pipeThrough(new DecompressionStream('gzip'))).text();
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

function storedChars(manifest: Manifest): number {
  return manifest.reduce((sum, [, chars]) => sum + chars, 0);
}

/**
 * Cache tier 2: localStorage, 1-hour TTL, least-recently-used entries evicted
 * once the compressed entries would pass `MAX_STORED_CHARS`, storing the
 * trimmed Graph shape (not the raw API response) -- per plan.md §3.
 *
 * Every read and write is wrapped in try/catch. localStorage throws outright in
 * some contexts (private browsing, disabled site data) and can hold corrupt or
 * foreign data even when it doesn't throw -- another tab, a previous app
 * version's shape, or manual tampering. Any failure here degrades to "treat as
 * a cache miss" (get) or "silently drop the write" (set); it never rejects, so
 * the graph client can always fall back to the network.
 */
export class LocalStorageGraphCache {
  private readonly storage: Storage;
  private readonly maxStoredChars: number;

  constructor(storage: Storage = globalThis.localStorage, options?: { readonly maxStoredChars?: number }) {
    this.storage = storage;
    this.maxStoredChars = options?.maxStoredChars ?? MAX_STORED_CHARS;
    this.dropUnlistedKeys();
  }

  async get(key: CacheKey): Promise<CacheEntry<Graph> | undefined> {
    let raw: string | null;
    try {
      raw = this.storage.getItem(entryKey(key));
    } catch {
      return undefined;
    }
    if (raw == null) return undefined;

    let record: unknown;
    try {
      record = JSON.parse(await gunzipBase64(raw));
    } catch {
      this.removeEntry(key);
      return undefined;
    }
    if (!isStoredRecordShape(record) || Date.now() - record.fetchedAt > TTL_MS) {
      this.removeEntry(key);
      return undefined;
    }
    const parsed = parseTrimmedGraph(record.value);
    if (!parsed.ok) {
      this.removeEntry(key);
      return undefined;
    }

    this.touch(key);
    return { value: parsed.value, fetchedAt: record.fetchedAt };
  }

  async set(key: CacheKey, entry: CacheEntry<Graph>): Promise<void> {
    const record: StoredRecord = { fetchedAt: entry.fetchedAt, value: toStorable(entry.value) };
    let encoded: string;
    try {
      encoded = await gzipBase64(JSON.stringify(record));
    } catch {
      return;
    }
    if (encoded.length > this.maxStoredChars) return;
    try {
      this.writeEntry(key, encoded);
    } catch {
      // Not a quota error, or nothing left to evict: the memory tier still has it.
    }
  }

  /** Manual invalidate/refresh path for one entry. */
  invalidate(key: CacheKey): void {
    this.removeEntry(key);
  }

  /** Manual invalidate/refresh path for the whole cache. */
  clear(): void {
    try {
      for (const [key] of this.readManifest()) this.storage.removeItem(entryKey(key));
      this.storage.removeItem(MANIFEST_KEY);
    } catch {
      // ignore
    }
  }

  /**
   * Synchronous from the first read of the manifest to the last write, so two
   * writes finishing compression together cannot interleave.
   */
  private writeEntry(key: CacheKey, encoded: string): void {
    const manifest = this.readManifest().filter(([k]) => k !== key);
    while (manifest.length > 0 && storedChars(manifest) + encoded.length > this.maxStoredChars) {
      this.evictOldest(manifest);
    }
    for (;;) {
      try {
        this.storage.setItem(entryKey(key), encoded);
        this.writeManifest([[key, encoded.length], ...manifest]);
        return;
      } catch (e) {
        // The browser's quota can be smaller than the budget, or shared with
        // other keys: make room one entry at a time.
        if (!isQuotaExceededError(e) || manifest.length === 0) {
          this.storage.removeItem(entryKey(key));
          this.writeManifest(manifest);
          throw e;
        }
        this.evictOldest(manifest);
      }
    }
  }

  private evictOldest(manifest: Manifest): void {
    const [evicted] = manifest.pop() as Manifest[number];
    this.storage.removeItem(entryKey(evicted));
  }

  private touch(key: CacheKey): void {
    try {
      const manifest = this.readManifest();
      const at = manifest.findIndex(([k]) => k === key);
      if (at <= 0) return;
      const [entry] = manifest.splice(at, 1);
      this.writeManifest([entry as Manifest[number], ...manifest]);
    } catch {
      // Recency bookkeeping is best-effort; losing it degrades eviction
      // ordering on a future write, not correctness of this read.
    }
  }

  private removeEntry(key: CacheKey): void {
    try {
      this.storage.removeItem(entryKey(key));
      this.writeManifest(this.readManifest().filter(([k]) => k !== key));
    } catch {
      // ignore
    }
  }

  /**
   * Removes every graph key the manifest does not list: earlier formats, and
   * an entry whose write stopped before the manifest named it. Such a key
   * would otherwise hold quota that eviction never frees.
   */
  private dropUnlistedKeys(): void {
    try {
      const listed = new Set([MANIFEST_KEY, ...this.readManifest().map(([key]) => entryKey(key))]);
      const keys = Array.from({ length: this.storage.length }, (_, i) => this.storage.key(i));
      for (const key of keys) {
        if (key?.startsWith(OWN_PREFIX) && !listed.has(key)) this.storage.removeItem(key);
      }
    } catch {
      // ignore
    }
  }

  private readManifest(): Manifest {
    try {
      const raw = this.storage.getItem(MANIFEST_KEY);
      if (raw == null) return [];
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(
        (v): v is [CacheKey, number] => Array.isArray(v) && typeof v[0] === 'string' && typeof v[1] === 'number',
      );
    } catch {
      return [];
    }
  }

  private writeManifest(manifest: Manifest): void {
    this.storage.setItem(MANIFEST_KEY, JSON.stringify(manifest));
  }
}
