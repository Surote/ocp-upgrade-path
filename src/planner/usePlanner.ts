import { useCallback, useEffect, useMemo, useState } from 'react';
import type { StitchedPathResult, StitchError } from '../engine/types';
import type { ControlPlaneOnlyLeg } from '../design/eus';
import type { GraphClient } from '../graph/client';
import { describeChannelLoadError } from './describeStitchError';
import { resolveVersion } from '../graph/parse';
import { ARCHES, type Arch, type Version } from '../graph/types';
import { isLegacyStream } from '../design/lifecycle';
import { formatStream, streamOf } from '../engine/version';
import {
  droppedMarksNotice,
  parseUrlState,
  resolveUrlArch,
  resolveUrlNotApplicable,
  resolveUrlRiskPolicy,
  syncUrlState,
} from '../url/urlState';
import type { RiskPolicy, RouteConstraints, StopOption } from '../engine/routeConstraints';
import { checkStops, stopReleases } from './stopFields';
import type { AsyncResult } from './useAsyncResult';
import { groupByStream, type StreamGroup } from './groupByStream';
import type { ChannelSegment } from '../engine/lookahead';
import { conditionalRisks, type RiskId } from '../engine/risks';
import { useLookahead } from './lookaheadTargets';
import { channelGroupLabel, sortChannels } from './sortChannels';
import { buildStartOptions, buildTargetOptions, offeredOptions, type TargetOption, versionStream } from './targetOptions';
import { useChannelCatalog } from './useChannelCatalog';
import { useGraphForSelection } from './useGraphForSelection';
import { useControlPlaneOnlyLegs } from './useControlPlaneOnlyLegs';
import { usePathSearch } from './usePathSearch';

const DEFAULT_ARCH: Arch = 'amd64';
const NO_SEGMENTS: readonly ChannelSegment[] = [];

export interface ChannelFieldViewModel {
  readonly value: string;
  readonly groups: readonly StreamGroup<string>[];
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
  readonly groups: readonly StreamGroup<Version>[];
  readonly loading: boolean;
  readonly disabled: boolean;
  readonly error?: string;
  /** The start's stream, e.g. `4.14`, when it is older than every stream Red Hat still supports in a standard term. */
  readonly legacyStream?: string;
  readonly onChange: (version: string) => void;
  readonly onRetry: () => void;
}

export interface TargetFieldViewModel {
  readonly value: string;
  /**
   * Newer-than-start targets from the selected channel and the look-ahead
   * channels beyond it (plan.md §6: selecting `eus-4.20` must still offer
   * `4.22.9`), merged newest first. A look-ahead target carries `via`, the
   * channel the route under the pinned stops and risk policy ends on.
   */
  readonly groups: readonly StreamGroup<TargetOption>[];
  /** True while look-ahead channels are still being fetched; in-channel targets are already listed. */
  readonly lookaheadLoading: boolean;
  readonly disabled: boolean;
  readonly onChange: (version: string) => void;
}

export interface StopFieldViewModel {
  readonly value: string;
  /** Newest first, one group per stream. */
  readonly groups: readonly StreamGroup<StopOption>[];
  /** Set when the stop can't be honored; the route is withheld until it is removed or replaced. */
  readonly error?: string;
  readonly onChange: (version: string) => void;
  readonly onRemove: () => void;
}

export interface RouteConstraintsViewModel {
  readonly stops: readonly StopFieldViewModel[];
  readonly canAddStop: boolean;
  readonly onAddStop: () => void;
  readonly riskPolicy: RiskPolicy;
  readonly onRiskPolicyChange: (policy: RiskPolicy) => void;
}

/**
 * The conditional risks the operator marked as not applying to their
 * cluster, shared by every risk card that offers the mark.
 */
export interface RiskApplicabilityViewModel {
  readonly notApplicable: ReadonlySet<RiskId>;
  readonly onChange: (id: RiskId, notApplicable: boolean) => void;
}

/** Why no route is searched although start and target are set. */
export type RouteHold = 'checkingStops' | 'invalidStops';

export interface FreshnessViewModel {
  readonly fetchedAt: number;
  readonly onRefresh: () => void;
}

export interface PlannerViewModel {
  readonly channel: ChannelFieldViewModel;
  readonly arch: ArchFieldViewModel;
  readonly start: StartFieldViewModel;
  readonly target: TargetFieldViewModel;
  readonly constraints: RouteConstraintsViewModel;
  readonly riskApplicability: RiskApplicabilityViewModel;
  /** The stops the route search was asked to honor, for marking on the map. */
  readonly pinnedStops: readonly Version[];
  readonly routeHold?: RouteHold;
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
  /** The route's Control Plane Only legs, each `checking` until its EUS graph loads. */
  readonly controlPlaneOnlyLegs: readonly ControlPlaneOnlyLeg[];
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
  const initialRiskPolicy = useMemo(() => resolveUrlRiskPolicy(initialUrl.avoid), [initialUrl.avoid]);
  const initialMarks = useMemo(() => resolveUrlNotApplicable(initialUrl.notApplicable), [initialUrl.notApplicable]);

  const [channel, setChannelState] = useState<string | undefined>(initialUrl.channel);
  const [arch, setArchState] = useState<Arch>(initialArch.arch);
  const [startRaw, setStartRaw] = useState(initialUrl.start ?? '');
  const [targetRaw, setTargetRaw] = useState(initialUrl.target ?? '');
  const [stopsRaw, setStopsRaw] = useState<readonly string[]>(initialUrl.stops ?? []);
  const [riskPolicy, setRiskPolicy] = useState<RiskPolicy>(initialRiskPolicy.riskPolicy);
  // The link's marks wait here until a loaded channel vouches for each one.
  const [linkedMarks, setLinkedMarks] = useState(initialMarks.ids.length > 0 ? initialMarks.ids : undefined);
  const [notApplicable, setNotApplicable] = useState<ReadonlySet<RiskId>>(() => new Set());
  const [marksNotice, setMarksNotice] = useState<string>();

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

  // The catalog stops at the 4.14 floor, but a saved link can select an older
  // channel. Once its graph loads the planner routes on it, so list it too.
  const listedChannels = useMemo(
    () =>
      channel && graph && !channelCatalog.channels.includes(channel)
        ? sortChannels([...channelCatalog.channels, channel])
        : channelCatalog.channels,
    [channel, graph, channelCatalog.channels],
  );

  // Look-ahead target discovery (plan.md §6), keyed on the loaded anchor
  // graph -- it doesn't need `start` to discover *which* channels exist
  // beyond the anchor, only to later decide which of their versions are
  // reachable (buildTargetOptions below). Used only while it matches the
  // anchor on screen, and handed to the path search with it, so the options
  // and the route always come from the same graphs.
  const anchorResult = graphState.status === 'success' ? graphState.value : undefined;
  const lookahead = useLookahead(client, channel, arch, anchorResult);
  const lookaheadSnapshot =
    lookahead.status === 'success' && lookahead.value.anchorFetchedAt === anchorResult?.fetchedAt ? lookahead.value : undefined;
  const lookaheadSegments = lookaheadSnapshot?.discovery.segments ?? NO_SEGMENTS;
  const lookaheadLoading = anchorResult !== undefined && lookaheadSnapshot === undefined;

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

  const markable = useMemo(
    () => conditionalRisks(graph ? [graph, ...lookaheadSegments.map((s) => s.graph)] : []),
    [graph, lookaheadSegments],
  );
  // A linked mark applies as soon as a loaded graph carries its advisory, so a
  // slow look-ahead never holds one on an anchor route; only dropping an
  // unmatched one waits for every graph.
  if (linkedMarks && graph) {
    const ids = linkedMarks.filter((id) => markable.has(id));
    const unmatched = linkedMarks.filter((id) => !markable.has(id));
    const settled = !lookaheadLoading;
    if (ids.length > 0) setNotApplicable((prev) => new Set([...prev, ...ids]));
    if (settled) setMarksNotice(droppedMarksNotice(unmatched));
    if (ids.length > 0 || settled) setLinkedMarks(settled || unmatched.length === 0 ? undefined : unmatched);
  }
  const markNotApplicable = useCallback((id: RiskId, marked: boolean) => {
    setNotApplicable((prev) => {
      const next = new Set(prev);
      if (marked) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  const startOptions = useMemo(() => (graph ? buildStartOptions(graph) : []), [graph]);
  const startStream = resolvedStart && streamOf(resolvedStart);
  const targetOptions = useMemo(
    () => (graph && resolvedStart ? buildTargetOptions(graph, resolvedStart, lookaheadSegments) : []),
    [graph, resolvedStart, lookaheadSegments],
  );

  // Only a listed target is searched, so a permalink whose target is the
  // start or older gets the notice below and no route alongside it.
  const targetOption = targetOptions.find((o) => o.version === resolvedTarget);

  const anchorSegment = useMemo(
    () => (graph && channel ? { channel, graph, classFallback: false as const } : undefined),
    [graph, channel],
  );
  const allSegments = useMemo(
    () => (anchorSegment ? [anchorSegment, ...lookaheadSegments] : NO_SEGMENTS),
    [anchorSegment, lookaheadSegments],
  );
  // The route search reads look-ahead only for a target outside the anchor
  // (engine/stitch.ts), so stops on an anchor target are judged on the anchor
  // alone, without waiting for discovery.
  const targetInAnchor = graph !== undefined && targetOption !== undefined && resolveVersion(graph, targetOption.version) !== undefined;
  const stopRows = useMemo(
    () =>
      checkStops(stopsRaw, {
        segments: targetInAnchor && anchorSegment ? [anchorSegment] : allSegments,
        start: resolvedStart,
        target: targetOption?.version,
        discovered: targetInAnchor || !lookaheadLoading,
      }),
    [stopsRaw, targetInAnchor, anchorSegment, allSegments, resolvedStart, targetOption, lookaheadLoading],
  );
  const routeHold: RouteHold | undefined = stopRows.some((r) => r.check.kind === 'invalid')
    ? 'invalidStops'
    : stopRows.some((r) => r.check.kind === 'pending')
      ? 'checkingStops'
      : undefined;
  const pinnedStops = useMemo(
    () => stopRows.flatMap((r) => (r.check.kind === 'valid' ? [r.check.version] : [])),
    [stopRows],
  );
  const routeConstraints = useMemo<RouteConstraints>(
    () => ({ stops: pinnedStops, riskPolicy, notApplicable }),
    [pinnedStops, riskPolicy, notApplicable],
  );
  // Selection and stop checks read `targetOptions`; only the labels follow the
  // constraints, since the stops are themselves checked against the target.
  // Labels use every stop that names a release, not just those the current
  // target honors, so each option names the route it gets once chosen.
  const labelConstraints = useMemo<RouteConstraints>(
    () => ({ stops: stopReleases(stopsRaw, allSegments), riskPolicy, notApplicable }),
    [stopsRaw, allSegments, riskPolicy, notApplicable],
  );
  const shownTargetOptions = useMemo(() => {
    const constrained = labelConstraints.stops.length > 0 || labelConstraints.riskPolicy !== 'recommended';
    return graph && resolvedStart && constrained ? buildTargetOptions(graph, resolvedStart, lookaheadSegments, labelConstraints) : targetOptions;
  }, [graph, resolvedStart, lookaheadSegments, labelConstraints, targetOptions]);

  const offered = <T extends { readonly version: Version }>(options: readonly T[], selected: string): readonly T[] =>
    channel && resolvedStart ? offeredOptions(options, { channel, start: resolvedStart, selected }) : options;

  const pathResult = usePathSearch(client, {
    channel,
    arch,
    start: resolvedStart,
    target: routeHold ? undefined : targetOption?.version,
    anchor: anchorResult && { ...anchorResult, lookahead: lookaheadSnapshot?.discovery },
    constraints: routeConstraints,
  });

  const controlPlaneOnlyLegs = useControlPlaneOnlyLegs(client, arch, pathResult).legs;

  // --- User-driven cascade (Q7/Q8): channel -> arch -> start -> target ---
  // Stops clear with the target; a target change keeps them, and any the
  // new target can't honor is flagged rather than dropped.
  const setChannel = useCallback((next: string) => {
    setChannelState(next || undefined);
    setStartRaw('');
    setTargetRaw('');
    setStopsRaw([]);
  }, []);
  const setArch = useCallback((next: Arch) => {
    setArchState(next);
    setStartRaw('');
    setTargetRaw('');
    setStopsRaw([]);
  }, []);
  const setStart = useCallback((next: string) => {
    setStartRaw(next);
    setTargetRaw(''); // target's reachable set is keyed on start
    setStopsRaw([]);
  }, []);
  const setTarget = useCallback((next: string) => setTargetRaw(next), []);
  const addStop = useCallback(() => setStopsRaw((prev) => [...prev, '']), []);
  const setStop = useCallback((index: number, next: string) => setStopsRaw((prev) => prev.map((s, i) => (i === index ? next : s))), []);
  const removeStop = useCallback((index: number) => setStopsRaw((prev) => prev.filter((_, i) => i !== index)), []);

  // --- Notices: garbage/unresolvable input degrades gracefully with a visible note (Q21) ---
  const notices = useMemo(() => {
    const list: string[] = [];
    if (initialArch.notice) list.push(initialArch.notice);
    if (initialRiskPolicy.notice) list.push(initialRiskPolicy.notice);
    if (initialMarks.notice) list.push(initialMarks.notice);
    if (marksNotice) list.push(marksNotice);
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
    if (resolvedTarget && resolvedStart) {
      if (!targetOption) {
        list.push(`Target version "${resolvedTarget}" from the link is not newer than the start version -- please choose a different target.`);
      } else if (!targetOption.reachable) {
        list.push(`Target version "${resolvedTarget}" from the link is not reachable from the start version -- please choose a different target.`);
      }
    }
    return list;
  }, [
    initialArch.notice,
    initialRiskPolicy.notice,
    initialMarks.notice,
    marksNotice,
    graph,
    startRaw,
    resolvedStart,
    targetRaw,
    resolvedTarget,
    channel,
    targetOption,
    lookaheadLoading,
  ]);

  // --- Permalink sync: replaceState only, never a new history entry (Q21) ---
  useEffect(() => {
    const marks = [...new Set([...(linkedMarks ?? []), ...notApplicable])];
    syncUrlState({ channel, arch, start: startRaw, target: targetRaw, stops: stopsRaw, riskPolicy, notApplicable: marks });
  }, [channel, arch, startRaw, targetRaw, stopsRaw, riskPolicy, linkedMarks, notApplicable]);

  return {
    channel: {
      value: channel ?? '',
      groups: groupByStream(listedChannels, channelGroupLabel),
      loading: channelCatalog.loading,
      error: channelCatalog.error,
      onChange: setChannel,
      onRetry: channelCatalog.retry,
    },
    arch: { value: arch, options: ARCHES, onChange: setArch },
    start: {
      value: startRaw,
      groups: groupByStream(startOptions, versionStream),
      loading: graphState.status === 'loading',
      disabled: !channel,
      error:
        graphState.status === 'error'
          ? describeChannelLoadError(channel ?? '', graphState.error)
          : undefined,
      legacyStream: startStream && isLegacyStream(startStream) ? formatStream(startStream) : undefined,
      onChange: setStart,
      onRetry: graphState.retry,
    },
    target: {
      value: targetRaw,
      groups: groupByStream(offered(shownTargetOptions, targetRaw), (o) => versionStream(o.version)),
      lookaheadLoading,
      disabled: !resolvedStart,
      onChange: setTarget,
    },
    constraints: {
      stops: stopRows.map((row, i) => ({
        value: row.raw,
        groups: groupByStream(offered(row.options, row.raw), (o) => versionStream(o.version)),
        error: row.check.kind === 'invalid' ? row.check.message : undefined,
        onChange: (version: string) => setStop(i, version),
        onRemove: () => removeStop(i),
      })),
      canAddStop: resolvedStart !== undefined && targetOption !== undefined,
      onAddStop: addStop,
      riskPolicy,
      onRiskPolicyChange: setRiskPolicy,
    },
    riskApplicability: { notApplicable, onChange: markNotApplicable },
    pinnedStops,
    routeHold,
    freshness:
      graphState.status === 'success' ? { fetchedAt: graphState.value.fetchedAt, onRefresh: graphState.refresh } : undefined,
    notices,
    result: pathResult,
    channelNames: graph?.channelNames ?? [],
    controlPlaneOnlyLegs,
  };
}
