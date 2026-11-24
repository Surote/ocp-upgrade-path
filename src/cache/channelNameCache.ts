const KEY = 'oup:channels:v1';
const TTL_MS = 24 * 60 * 60 * 1000;

/** What backward channel discovery has learned: channels that exist, and probed names that came back empty. */
export interface ChannelNames {
  readonly present: readonly string[];
  readonly empty: readonly string[];
}

const NONE: ChannelNames = { present: [], empty: [] };

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

function parseRecord(raw: string | null): (ChannelNames & { readonly savedAt: number }) | undefined {
  if (raw == null) return undefined;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== 'object' || value === null) return undefined;
    const { savedAt, present, empty } = value as Record<string, unknown>;
    if (typeof savedAt !== 'number' || !isStringArray(present) || !isStringArray(empty)) return undefined;
    return { savedAt, present, empty };
  } catch {
    return undefined;
  }
}

/**
 * Discovered channel names, kept under their own localStorage key rather
 * than in the graph LRU, so a warm load skips the probes without the probed
 * graphs having to survive eviction. A failed probe is never recorded, so
 * the next load probes it again. Like the graph cache, any storage failure
 * reads as "nothing known" and never throws.
 */
export class ChannelNameCache {
  private readonly storage: Storage;

  constructor(storage: Storage = globalThis.localStorage) {
    this.storage = storage;
  }

  read(): ChannelNames {
    try {
      const record = parseRecord(this.storage.getItem(KEY));
      if (!record || Date.now() - record.savedAt > TTL_MS) return NONE;
      return { present: record.present, empty: record.empty };
    } catch {
      return NONE;
    }
  }

  /** Unions `update` into what is stored; the whole record expires a day after the last call. */
  record(update: ChannelNames): void {
    const current = this.read();
    const next = {
      savedAt: Date.now(),
      present: [...new Set([...current.present, ...update.present])],
      empty: [...new Set([...current.empty, ...update.empty])],
    };
    try {
      this.storage.setItem(KEY, JSON.stringify(next));
    } catch {
      // Losing this only costs the next load its probes again.
    }
  }
}
