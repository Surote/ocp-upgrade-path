import { useCallback, useMemo, useState } from 'react';
import type { GraphClient } from '../graph/client';
import { describeGraphError } from '../graph/errors';
import { sortChannels } from './sortChannels';
import { useAsyncResult } from './useAsyncResult';

/**
 * The one channel fetched unconditionally at load, per plan.md §6 / Q6/Q7
 * ("seed-and-expand channel discovery"): there is no endpoint that lists
 * channels, only per-node metadata naming them, which requires a graph in
 * hand to read at all. `stable-4.20` is known-good (it's the pinned Phase 1
 * fixture and the plan's own worked example) and, per the live API, yields
 * all 18 channels through 4.22.
 */
const SEED_CHANNEL = 'stable-4.20';
const SEED_ARCH = 'amd64';

export interface ChannelCatalog {
  /** Every channel name discovered so far (seed plus anything unioned in via `addChannels`), sorted per `sortChannels`. */
  readonly channels: readonly string[];
  readonly loading: boolean;
  /** Names the seed channel, per plan.md §6 ("the error names which channel fetch failed"). */
  readonly error?: string;
  readonly retry: () => void;
  /** Unions more channel names in -- called whenever any other graph fetch succeeds, per Q6's "the list expands as the user navigates". */
  readonly addChannels: (names: readonly string[]) => void;
}

/**
 * Seed-and-expand channel discovery (plan.md Q6/Q7). Fetches `SEED_CHANNEL`
 * once at mount to read its `channelNames` table (Phase 1's interned
 * per-graph channel-name list); the caller is expected to call
 * `addChannels` with every subsequently-fetched graph's `channelNames` too,
 * so navigating to a channel outside the seed's own span still grows the
 * catalog. Nothing beyond `SEED_CHANNEL` is hardcoded.
 */
export function useChannelCatalog(client: GraphClient): ChannelCatalog {
  // `known` accumulates channel names discovered from graphs OTHER than the
  // seed (i.e. via `addChannels`, called by the caller whenever some other
  // (channel, arch) fetch succeeds) -- a genuine accumulator across separate
  // async events over time, so it has to be real state updated from an
  // effect at the call site, not something derivable from one render's
  // inputs. The seed channel's own contribution is folded in below via
  // `useMemo` instead of a second `setState`-in-effect for the same set,
  // since it's derivable from `seed`'s current value on every render.
  const [known, setKnown] = useState<ReadonlySet<string>>(new Set());

  const seed = useAsyncResult(true, `${SEED_CHANNEL}|${SEED_ARCH}`, (signal) =>
    client.getGraph({ channel: SEED_CHANNEL, arch: SEED_ARCH }, { signal }),
  );

  const addChannels = useCallback((names: readonly string[]) => {
    if (names.length === 0) return;
    setKnown((prev) => {
      const next = new Set(prev);
      let changed = false;
      for (const name of names) {
        if (!next.has(name)) {
          next.add(name);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, []);

  const seedChannelNames = seed.status === 'success' ? seed.value.graph.channelNames : undefined;
  const channels = useMemo(() => {
    const merged = new Set(known);
    if (seedChannelNames) {
      for (const name of seedChannelNames) merged.add(name);
    }
    return sortChannels([...merged]);
  }, [known, seedChannelNames]);

  return {
    channels,
    loading: seed.status === 'loading',
    error: seed.status === 'error' ? `Channel discovery (seed "${SEED_CHANNEL}") failed: ${describeGraphError(seed.error)}` : undefined,
    retry: seed.retry,
    addChannels,
  };
}
