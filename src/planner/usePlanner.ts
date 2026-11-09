import { useCallback, useEffect, useMemo, useState } from 'react';
import type { StitchedPathResult, StitchError } from '../engine/types';
import type { GraphClient } from '../graph/client';
import { describeChannelLoadError } from './describeStitchError';
import { resolveVersion } from '../graph/parse';
import { ARCHES, type Arch, type Version } from '../graph/types';
import { parseUrlState, resolveUrlArch, syncUrlState } from '../url/urlState';
import type { AsyncResult } from './useAsyncResult';
import { buildLookaheadTargetOptions, type LookaheadTargetOption, useLookaheadSegments } from './lookaheadTargets';
import { buildStartOptions, buildTargetOptions, type TargetOption } from './targetOptions';
import { useChannelCatalog } from './useChannelCatalog';
import { useGraphForSelection } from './useGraphForSelection';
import { usePathSearch } from './usePathSearch';

const DEFAULT_ARCH: Arch = 'amd64';

export interface ChannelFieldViewModel {
  readonly value: string;
  readonly options: readonly string[];
  readonly loading: boolean;
  readonly error?: string;
  readonly onChange: (channel: string) => void;
  readonly onRetry: () => void;
}

export interface ArchFieldViewModel {
  readonly value: Arch;
  readonly options: readonly Arch[];
  readonly onChange: (arch: Arch) => void;
}

export interface StartFieldViewModel {
  readonly value: string;
  readonly options: readonly Version[];
  readonly loading: boolean;
  readonly disabled: boolean;
  readonly error?: string;
  readonly onChange: (version: string) => void;
  readonly onRetry: () => void;
}

export interface TargetFieldViewModel {
  readonly value: string;
  readonly options: readonly TargetOption[];
  /**
   * Targets beyond the selected (anchor) channel's own graph -- plan.md §6
   * "Look-ahead targets (bidirectional stitching)": selecting `eus-4.20`
   * must still offer `4.22.9`. Each carries the real channel it was found
   * in (`viaChannel`) and whether that channel is a different class than
   * the anchor's (`classFallback`), so the UI can mark them
   * as "requires a channel change" before the user chooses one, per
   * requirement 4/5 -- never silently mixed into `options` above.
   */
  readonly lookaheadOptions: readonly LookaheadTargetOption[];
  /** True while look-ahead channels are still being discovered/fetched -- lets the UI show a distinct "still looking further ahead" state without blocking the in-channel `options` above. */
  readonly lookaheadLoading: boolean;
  readonly disabled: boolean;
  readonly onChange: (version: string) => void;
}

export interface FreshnessViewModel {
  readonly fetchedAt: number;
  readonly onRefresh: () => void;
}

export interface PlannerViewModel {
  readonly channel: ChannelFieldViewModel;
  readonly arch: ArchFieldViewModel;
  readonly start: StartFieldViewModel;
  readonly target: TargetFieldViewModel;
  readonly freshness?: FreshnessViewModel;
  /** Visible notes for anything that degraded gracefully rather than crashing -- garbage URL params, an unresolvable start/target, a disabled target named by a permalink (plan.md Q21). */
  readonly notices: readonly string[];
  readonly result: AsyncResult<StitchedPathResult, StitchError>;
  /**
   * The selected channel's own `channelNames` table -- for resolving
   * `GraphNode.channels` indices in the node-detail panel (Phase 4). Only
   * matches the indices on nodes that actually came from this same graph;
   * see design/channels.ts for why a multi-graph stitch can't reuse it for
   * every station.
   */
  readonly channelNames: readonly string[];
}

/**
 * The whole cascading-dropdown state machine (plan.md §6 / Q7 / Q8 / Q21 /
 * Q30), as one hook so `App.tsx` stays a thin render of whatever this
 * returns. Composes:
 *  - `useChannelCatalog` for seed-and-expand channel discovery,
 *  - `useGraphForSelection` for the (channel, arch) graph that seeds both
 *    the start and target dropdowns (see the implementation report for the
 *    resulting start-dropdown limitation this choice carries),
 *  - `usePathSearch` for the actual path once all four selections resolve,
 *  - `../url/urlState` for permalink restore-on-load and replaceState sync.
 *
 * Cascade rule: changing channel or arch clears the start and target
 * selections (their graph is about to change); changing start clears target
 * (its reachable set is about to change). Nothing here re-validates a
 * *user-driven* selection against a stale graph -- the clear-on-change makes
 * that state unreachable by construction. The only place a selection can be
 * "invalid" is on initial load, where it came from an untrusted URL --
 * handled by resolving against the graph once it loads and surfacing a
 * notice rather than crashing or silently accepting garbage.
 */
export function usePlanner(client: GraphClient): PlannerViewModel {
  const initialUrl = useMemo(() => parseUrlState(window.location.search), []);
  const initialArch = useMemo(() => resolveUrlArch(initialUrl.arch, DEFAULT_ARCH), [initialUrl.arch]);

  const [channel, setChannelState] = useState<string | undefined>(initialUrl.channel);
  const [arch, setArchState] = useState<Arch>(initialArch.arch);
  const [startRaw, setStartRaw] = useState(initialUrl.start ?? '');
  const [targetRaw, setTargetRaw] = useState(initialUrl.target ?? '');

  const channelCatalog = useChannelCatalog(client);
  const graphState = useGraphForSelection(client, channel, arch);

  // Q6/Q7 "expand": union in whatever channels the currently-selected
  // graph's own channelNames table names, even when that channel is outside
  // the seed's span -- so navigating there via a permalink still grows the
  // catalog for next time.
  const loadedChannelNames = graphState.status === 'success' ? graphState.value.graph.channelNames : undefined;
  const { addChannels } = channelCatalog;
  useEffect(() => {
    if (loadedChannelNames) addChannels(loadedChannelNames);
  }, [loadedChannelNames, addChannels]);

  const graph = graphState.status === 'success' ? graphState.value.graph : undefined;

  // Look-ahead target discovery (plan.md §6): fetched lazily, keyed on
  // (channel, arch) alone -- it doesn't need `start` to discover *which*
  // channels exist beyond the anchor, only to later decide which of their
  // versions are reachable (buildLookaheadTargetOptions below).
  const lookahead = useLookaheadSegments(client, channel, arch);
  const lookaheadSegments = lookahead.status === 'success' ? lookahead.value : [];
  const lookaheadLoading = lookahead.status === 'loading';

  const resolvedStart = useMemo(() => (graph && startRaw ? resolveVersion(graph, startRaw) : undefined), [graph, startRaw]);
  const resolvedTarget = useMemo(() => {
    if (!targetRaw) return undefined;
    if (graph) {
      const inAnchor = resolveVersion(graph, targetRaw);
      if (inAnchor) return inAnchor;
    }
    // Not in the anchor's own graph -- per plan.md §6, a permalink target
    // can legitimately live only in a look-ahead channel (e.g.
    // `?channel=eus-4.20&target=4.22.9`); resolve against whichever
    // look-ahead segment actually contains it.
    for (const segment of lookaheadSegments) {
      const resolved = resolveVersion(segment.graph, targetRaw);
      if (resolved) return resolved;
    }
    return undefined;
  }, [graph, targetRaw, lookaheadSegments]);

  const startOptions = useMemo(() => (graph ? buildStartOptions(graph) : []), [graph]);
  const targetOptions = useMemo(
    () => (graph && resolvedStart ? buildTargetOptions(graph, resolvedStart) : []),
    [graph, resolvedStart],
  );
  const lookaheadOptions = useMemo(
    () => (graph && resolvedStart ? buildLookaheadTargetOptions(graph, resolvedStart, lookaheadSegments) : []),
    [graph, resolvedStart, lookaheadSegments],
  );

  const pathResult = usePathSearch(client, { channel, arch, start: resolvedStart, target: resolvedTarget });

  // --- User-driven cascade (Q7/Q8): channel -> arch -> start -> target ---
  const setChannel = useCallback((next: string) => {
    setChannelState(next || undefined);
    setStartRaw('');
    setTargetRaw('');
  }, []);
  const setArch = useCallback((next: Arch) => {
    setArchState(next);
    setStartRaw('');
    setTargetRaw('');
  }, []);
  const setStart = useCallback((next: string) => {
    setStartRaw(next);
    setTargetRaw(''); // target's reachable set is keyed on start
  }, []);
  const setTarget = useCallback((next: string) => setTargetRaw(next), []);

  // --- Notices: garbage/unresolvable input degrades gracefully with a visible note (Q21) ---
  const notices = useMemo(() => {
    const list: string[] = [];
    if (initialArch.notice) list.push(initialArch.notice);
    if (graph && startRaw && !resolvedStart) {
      list.push(`Start version "${startRaw}" from the link was not found in channel "${channel}" -- please reselect.`);
    }
    // Gated on `!lookaheadLoading`: while look-ahead channels are still
    // being fetched, `resolvedTarget` can be legitimately "not yet known"
    // rather than "genuinely absent" -- a target living only in a
    // look-ahead channel (plan.md §6) must not flash a false "not found"
    // notice before discovery has had a chance to find it.
    if (graph && targetRaw && resolvedStart && !resolvedTarget && !lookaheadLoading) {
      list.push(`Target version "${targetRaw}" from the link was not found in channel "${channel}" -- please reselect.`);
    }
    if (resolvedTarget) {
      const opt =
        targetOptions.find((o) => o.version === resolvedTarget) ?? lookaheadOptions.find((o) => o.version === resolvedTarget);
      if (opt?.disabled) {
        list.push(`Target version "${resolvedTarget}" from the link is ${opt.reason} -- please choose a different target.`);
      }
    }
    return list;
  }, [
    initialArch.notice,
    graph,
    startRaw,
    resolvedStart,
    targetRaw,
    resolvedTarget,
    channel,
    targetOptions,
    lookaheadOptions,
    lookaheadLoading,
  ]);

  // --- Permalink sync: replaceState only, never a new history entry (Q21) ---
  useEffect(() => {
    syncUrlState({ channel, arch, start: startRaw, target: targetRaw });
  }, [channel, arch, startRaw, targetRaw]);

  return {
    channel: {
      value: channel ?? '',
      options: channelCatalog.channels,
      loading: channelCatalog.loading,
      error: channelCatalog.error,
      onChange: setChannel,
      onRetry: channelCatalog.retry,
    },
    arch: { value: arch, options: ARCHES, onChange: setArch },
    start: {
      value: startRaw,
      options: startOptions,
      loading: graphState.status === 'loading',
      disabled: !channel,
      error:
        graphState.status === 'error'
          ? describeChannelLoadError(channel ?? '', graphState.error)
          : undefined,
      onChange: setStart,
      onRetry: graphState.retry,
    },
    target: {
      value: targetRaw,
      options: targetOptions,
      lookaheadOptions,
      lookaheadLoading,
      disabled: !resolvedStart,
      onChange: setTarget,
    },
    freshness:
      graphState.status === 'success' ? { fetchedAt: graphState.value.fetchedAt, onRefresh: graphState.refresh } : undefined,
    notices,
    result: pathResult,
    channelNames: graph?.channelNames ?? [],
  };
}
