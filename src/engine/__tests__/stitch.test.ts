import { describe, expect, it } from 'vitest';
import { buildHopCommands } from '../../design/commands';
import { parseRawGraph } from '../../graph/parse';
import type { Graph, Version } from '../../graph/types';
import { err, ok, type Result } from '../../lib/result';
import type { GraphError } from '../../graph/errors';
import { buildTargetOptions } from '../../planner/targetOptions';
import { loadFixture } from '../../test-utils/fixtures';
import { discoverLookahead } from '../lookahead';
import { stitchAndFindPath } from '../stitch';
import type { GraphLoader } from '../types';
import * as fx from './routeFixtures';

function v(s: string): Version {
  return s as Version;
}

/**
 * Builds a synthetic Graph via the real parse boundary, with a distinguishable payload per node so tests can prove *which* graph's copy of an overlapping node won.
 * `channels` is the membership every node advertises; the forward walk follows it to newer streams.
 */
function rawGraph(
  nodeVersions: readonly string[],
  edges: ReadonlyArray<readonly [number, number]>,
  payloadTag: string,
  channels: readonly string[] = [],
): Graph {
  const raw = {
    version: 1,
    nodes: nodeVersions.map((version, i) => ({
      version,
      payload: `quay.io/openshift-release-dev/ocp-release@sha256:${payloadTag}-${i}`,
      metadata: {
        url: `https://access.redhat.com/errata/${payloadTag}-${i}`,
        'io.openshift.upgrades.graph.release.channels': channels.join(','),
      },
    })),
    edges: edges.map(([a, b]) => [a, b]),
    conditionalEdges: [],
  };
  const result = parseRawGraph(raw, { channel: 'test', arch: 'amd64' });
  if (!result.ok) throw new Error(`rawGraph: ${JSON.stringify(result.error)}`);
  return result.value;
}

describe('stitchAndFindPath — single-graph fast path', () => {
  it('resolves entirely within the target channel when it already contains the start version, with full alternates support', () => {
    const graph = rawGraph(
      ['4.18.0', '4.19.10', '4.19.20', '4.20.0'],
      [
        [0, 1],
        [0, 2],
        [1, 3],
        [2, 3],
      ],
      'stable420',
    );
    const loader: GraphLoader = async (channel) => {
      if (channel === 'stable-4.20') return ok(graph);
      throw new Error(`unexpected channel fetch: ${channel}`);
    };

    return stitchAndFindPath(loader, { targetChannel: 'stable-4.20', arch: 'amd64', start: v('4.18.0'), target: v('4.20.0') }).then(
      (result) => {
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        // StitchInfo grew a `classFallbacks` field for plan.md §6 "Look-ahead
        // targets (bidirectional stitching)" -- empty here since this query
        // never walks forward (deliberate test update, not a regression).
        expect(result.value.stitch).toEqual({ channelsUsed: ['stable-4.20'], classFallbacks: [], multiGraph: false });
        expect(result.value.primary.versions).toEqual([v('4.18.0'), v('4.19.20'), v('4.20.0')]); // higher-patch waypoint wins
        expect(result.value.alternates).toHaveLength(1); // the 4.19.10 waypoint
        expect(result.value.nodeInfo.get(v('4.18.0'))?.payload).toContain('stable420');
        // Per-hop provenance (plan.md §6): every hop of a single-graph path
        // carries the same `sourceChannel` -- there is only one fetched
        // graph -- which is exactly why a single-graph query can never need
        // a channel switch (design/commands.ts consults this directly).
        expect(result.value.primary.hops.every((h) => h.sourceChannel === 'stable-4.20')).toBe(true);
      },
    );
  });
});

describe('stitchAndFindPath — multi-graph walk-back', () => {
  // stable-4.20 (target channel) spans {4.19, 4.20}; does NOT contain the 4.18 start.
  // stable-4.19 spans {4.18, 4.19} and shares node 4.19.5 with stable-4.20 -- the junction.
  const stable420 = rawGraph(['4.19.5', '4.20.1'], [[0, 1]], 'A');
  const stable419 = rawGraph(['4.18.1', '4.19.5'], [[0, 1]], 'B');

  function makeLoader(calls: string[]): GraphLoader {
    return async (channel) => {
      calls.push(channel);
      if (channel === 'stable-4.20') return ok(stable420);
      if (channel === 'stable-4.19') return ok(stable419);
      return err({ kind: 'empty', channel, arch: 'amd64' });
    };
  }

  it('walks back one channel to cover the start, and composes per-segment paths glued at the shared junction node', async () => {
    const calls: string[] = [];
    const result = await stitchAndFindPath(makeLoader(calls), {
      targetChannel: 'stable-4.20',
      arch: 'amd64',
      start: v('4.18.1'),
      target: v('4.20.1'),
    });

    expect(calls).toEqual(['stable-4.20', 'stable-4.19']); // target-channel-first
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // See the "single-graph fast path" test above for why `classFallbacks` is now part of this shape.
    expect(result.value.stitch).toEqual({
      channelsUsed: ['stable-4.20', 'stable-4.19'],
      classFallbacks: [],
      multiGraph: true,
    });
    expect(result.value.primary.versions).toEqual([v('4.18.1'), v('4.19.5'), v('4.20.1')]);
    expect(result.value.primary.cost.hops).toBe(2);
    // Documented scope decision: multi-graph stitches return primary only.
    expect(result.value.alternates).toEqual([]);
  });

  it('"later channel wins": nodeInfo for the overlapping junction node comes from the target-side (later) channel', async () => {
    const result = await stitchAndFindPath(makeLoader([]), {
      targetChannel: 'stable-4.20',
      arch: 'amd64',
      start: v('4.18.1'),
      target: v('4.20.1'),
    });
    if (!result.ok) throw result.error;

    // 4.19.5 exists in both stable-4.20 (payload tag "A", fetched first / later
    // channel) and stable-4.19 (tag "B", fetched via walk-back). "A" must win.
    const junction = result.value.nodeInfo.get(v('4.19.5'));
    expect(junction?.payload).toContain('sha256:A-');
  });

  it('never fabricates a transition: two graphs with NO shared/overlapping version cannot be stitched into a path, even if each individually has usable edges', async () => {
    // stable-4.20 covers 4.19 via "4.19.5"; stable-4.19 covers 4.19 via a
    // DIFFERENT specific version "4.19.9" -- no genuine overlap, so there is
    // no legitimate join point. A naive edge-union implementation might still
    // find *a* route; this one must not.
    const gapTarget = rawGraph(['4.19.5', '4.20.1'], [[0, 1]], 'GT');
    const gapStart = rawGraph(['4.18.1', '4.19.9'], [[0, 1]], 'GS');
    const loader: GraphLoader = async (channel) => {
      if (channel === 'stable-4.20') return ok(gapTarget);
      if (channel === 'stable-4.19') return ok(gapStart);
      return err({ kind: 'empty', channel, arch: 'amd64' });
    };

    const result = await stitchAndFindPath(loader, {
      targetChannel: 'stable-4.20',
      arch: 'amd64',
      start: v('4.18.1'),
      target: v('4.20.1'),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('unreachable');
  });
});

// plan.md §6 "Look-ahead targets (bidirectional stitching)": the selected
// channel is an *anchor*, not necessarily the target's own channel. These
// cases mirror the live-verified `eus-4.20 -> eus-4.22` scenario at small
// synthetic scale: `eus-4.20` spans {18,19,20}, `eus-4.22` spans {20,21,22},
// and the two share their 4.20.x band -- the join.
describe('stitchAndFindPath — forward walk (look-ahead targets)', () => {
  it('joins directly at a shared version when a same-class forward channel already reaches back to the anchor, with no unnecessary intermediate channel', async () => {
    const anchor = rawGraph(['4.18.0', '4.19.0', '4.20.0'], [[0, 1], [1, 2]], 'ANCHOR', ['eus-4.20', 'eus-4.22']);
    const forward = rawGraph(['4.20.0', '4.21.0', '4.22.0'], [[0, 1], [1, 2]], 'FWD');
    const calls: string[] = [];
    const loader: GraphLoader = async (channel) => {
      calls.push(channel);
      if (channel === 'eus-4.20') return ok(anchor);
      if (channel === 'eus-4.22') return ok(forward);
      return err({ kind: 'empty', channel, arch: 'amd64' });
    };

    const result = await stitchAndFindPath(loader, {
      targetChannel: 'eus-4.20',
      arch: 'amd64',
      start: v('4.18.0'),
      target: v('4.22.0'),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Never fabricates: the same-class candidate is tried first and
    // succeeds, so `stable-4.22` is never even probed, and no intermediate
    // `eus-4.21`/`stable-4.21` channel is fetched at all -- the join happens
    // directly at the shared 4.20.x band.
    expect(calls).toEqual(['eus-4.20', 'eus-4.22']);
    expect(result.value.stitch).toEqual({
      channelsUsed: ['eus-4.20', 'eus-4.22'],
      classFallbacks: [],
      multiGraph: true,
    });
    expect(result.value.primary.versions).toEqual([v('4.18.0'), v('4.19.0'), v('4.20.0'), v('4.21.0'), v('4.22.0')]);

    // Per-hop provenance names the real fetched channel that produced each
    // hop, and the switch happens at exactly the hop that actually crosses
    // the segment boundary -- the shared 4.20.0 junction -- not on the
    // minor crossing itself (which is one hop later).
    const sourceChannels = result.value.primary.hops.map((h) => h.sourceChannel);
    expect(sourceChannels).toEqual(['eus-4.20', 'eus-4.20', 'eus-4.22', 'eus-4.22']);
  });

  // plan.md §6 "Where the switch is attributed matters": the cluster stays on
  // its channel while that channel publishes the next hop, even when the
  // destination channel also lists (and publishes) the stations in between.
  it('switches channel only at the hop the current channel does not publish', async () => {
    // eus-4.20: a straight chain through the whole range, including three
    // 4.20.x releases that are *also* members of eus-4.22 below.
    const anchor = rawGraph(
      ['4.18.0', '4.19.0', '4.20.0', '4.20.5', '4.20.9'],
      [[0, 1], [1, 2], [2, 3], [3, 4]],
      'ANCHOR',
      ['eus-4.20', 'eus-4.22'],
    );
    // eus-4.22 publishes the same 4.20.x hops, so the route search keeps the
    // anchor's equal-cost route to 4.20.9 and lands its boundary there.
    const forward = rawGraph(
      ['4.20.0', '4.20.5', '4.20.9', '4.21.0', '4.22.0'],
      [[0, 1], [1, 2], [2, 3], [3, 4]],
      'FWD',
    );
    const loader: GraphLoader = async (channel) => {
      if (channel === 'eus-4.20') return ok(anchor);
      if (channel === 'eus-4.22') return ok(forward);
      return err({ kind: 'empty', channel, arch: 'amd64' });
    };

    const result = await stitchAndFindPath(loader, {
      targetChannel: 'eus-4.20',
      arch: 'amd64',
      start: v('4.18.0'),
      target: v('4.22.0'),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.primary.versions).toEqual([
      v('4.18.0'),
      v('4.19.0'),
      v('4.20.0'),
      v('4.20.5'),
      v('4.20.9'),
      v('4.21.0'),
      v('4.22.0'),
    ]);

    const sourceChannels = result.value.primary.hops.map((h) => h.sourceChannel);
    expect(sourceChannels).toEqual(['eus-4.20', 'eus-4.20', 'eus-4.20', 'eus-4.20', 'eus-4.22', 'eus-4.22']);
  });

  it('falls back to stable at a minor where the anchor\'s own class has no channel (EUS odd minors), and records the fallback', async () => {
    const anchor = rawGraph(['4.18.0', '4.19.0', '4.20.0'], [[0, 1], [1, 2]], 'ANCHOR', ['eus-4.20', 'eus-4.21', 'stable-4.21']);
    // stable-4.21 spans back to 4.20, per the live-verified table in plan.md §6.
    const stable421 = rawGraph(['4.20.0', '4.21.5'], [[0, 1]], 'S421');
    const calls: string[] = [];
    const loader: GraphLoader = async (channel) => {
      calls.push(channel);
      if (channel === 'eus-4.20') return ok(anchor);
      if (channel === 'eus-4.21') return err({ kind: 'empty', channel, arch: 'amd64' }); // does not exist -- EUS is even-minor only
      if (channel === 'stable-4.21') return ok(stable421);
      return err({ kind: 'empty', channel, arch: 'amd64' });
    };

    const result = await stitchAndFindPath(loader, {
      targetChannel: 'eus-4.20',
      arch: 'amd64',
      start: v('4.18.0'),
      target: v('4.21.5'),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(calls).toEqual(['eus-4.20', 'eus-4.21', 'stable-4.21']); // same class probed first, per plan.md §6
    expect(result.value.stitch.channelsUsed).toEqual(['eus-4.20', 'stable-4.21']);
    expect(result.value.stitch.classFallbacks).toEqual([{ channel: 'stable-4.21', requestedClass: 'eus', requestedStatus: 'unpublished' }]);
    expect(result.value.primary.hops.at(-1)?.sourceChannel).toBe('stable-4.21');
  });

  it('walks through multiple forward minors, lowest first, falling back to stable only at the minor that needs it', async () => {
    const anchor = rawGraph(['4.18.0', '4.19.0', '4.20.0'], [[0, 1], [1, 2]], 'ANCHOR', ['eus-4.20', 'eus-4.22']);
    const eus422 = rawGraph(['4.20.0', '4.21.0', '4.22.0'], [[0, 1], [1, 2]], 'E422', ['eus-4.22', 'eus-4.23', 'stable-4.23']);
    const stable423 = rawGraph(['4.22.0', '4.23.0'], [[0, 1]], 'S423');
    const calls: string[] = [];
    const loader: GraphLoader = async (channel) => {
      calls.push(channel);
      if (channel === 'eus-4.20') return ok(anchor);
      if (channel === 'eus-4.23') return err({ kind: 'empty', channel, arch: 'amd64' }); // odd minor -- no EUS channel
      if (channel === 'stable-4.23') return ok(stable423);
      if (channel === 'eus-4.22') return ok(eus422);
      return err({ kind: 'empty', channel, arch: 'amd64' });
    };

    const result = await stitchAndFindPath(loader, {
      targetChannel: 'eus-4.20',
      arch: 'amd64',
      start: v('4.18.0'),
      target: v('4.23.0'),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Lowest stream first, the same walk the target dropdown uses: 4.22
    // (same class), then 4.23 (no eus channel, falls back to stable).
    expect(calls).toEqual(['eus-4.20', 'eus-4.22', 'eus-4.23', 'stable-4.23']);
    expect(result.value.stitch.channelsUsed).toEqual(['eus-4.20', 'eus-4.22', 'stable-4.23']);
    expect(result.value.stitch.classFallbacks).toEqual([{ channel: 'stable-4.23', requestedClass: 'eus', requestedStatus: 'unpublished' }]);
    expect(result.value.primary.versions).toEqual([
      v('4.18.0'),
      v('4.19.0'),
      v('4.20.0'),
      v('4.21.0'),
      v('4.22.0'),
      v('4.23.0'),
    ]);
    // Two distinct switches: into eus-4.22 at the anchor/eus-4.22 junction,
    // then into stable-4.23 at the eus-4.22/stable-4.23 junction -- the
    // latter is the genuine eus -> stable drop the UI must call out.
    const sourceChannels = result.value.primary.hops.map((h) => h.sourceChannel);
    expect(sourceChannels).toEqual(['eus-4.20', 'eus-4.20', 'eus-4.22', 'eus-4.22', 'stable-4.23']);
  });

  it('keeps a reachable same-class route over a shorter one on candidate, in both the route and the target dropdown', async () => {
    const anchor = rawGraph(['4.20.0'], [], 'ANCHOR', ['stable-4.20', 'stable-4.21', 'candidate-4.22']);
    const stable421 = rawGraph(['4.20.0', '4.21.0', '4.21.1'], [[0, 1], [1, 2]], 'S421');
    const candidate422 = rawGraph(['4.20.0', '4.21.1', '4.22.0'], [[0, 1], [1, 2]], 'C422');
    const loader: GraphLoader = async (channel) => {
      if (channel === 'stable-4.20') return ok(anchor);
      if (channel === 'stable-4.21') return ok(stable421);
      if (channel === 'candidate-4.22') return ok(candidate422);
      return err({ kind: 'empty', channel, arch: 'amd64' });
    };

    const result = await stitchAndFindPath(loader, {
      targetChannel: 'stable-4.20',
      arch: 'amd64',
      start: v('4.20.0'),
      target: v('4.21.1'),
    });
    if (!result.ok) throw new Error(result.error.kind);
    expect(result.value.primary.hops.map((h) => [h.to, h.sourceChannel])).toEqual([
      [v('4.21.0'), 'stable-4.21'],
      [v('4.21.1'), 'stable-4.21'],
    ]);
    expect(result.value.stitch.classFallbacks).toEqual([]);

    const { segments } = await discoverLookahead(loader, 'stable-4.20', anchor, 'amd64');
    const option = buildTargetOptions(anchor, v('4.20.0'), segments).find((o) => o.version === v('4.21.1'));
    expect(option?.via).toEqual({ channel: 'stable-4.21', classFallback: false });
  });

  it('tries a preferred channel a later graph names for a stream already reached through a fallback, keeping the fallback that joins it', async () => {
    // stable-5.0 has no 4.22 upgrade sources, so only fast-5.0's 5.0.z name it.
    const anchor = rawGraph(['4.22.20'], [], 'ANCHOR', ['stable-4.22', 'fast-5.0']);
    const fast50 = rawGraph(['4.22.20', '5.0.0'], [[0, 1]], 'F50', ['fast-5.0', 'stable-5.0']);
    const stable50 = rawGraph(['5.0.0', '5.0.3'], [[0, 1]], 'S50', ['stable-5.0']);
    const loader: GraphLoader = async (channel) => {
      if (channel === 'stable-4.22') return ok(anchor);
      if (channel === 'fast-5.0') return ok(fast50);
      if (channel === 'stable-5.0') return ok(stable50);
      return err({ kind: 'empty', channel, arch: 'amd64' });
    };

    const result = await stitchAndFindPath(loader, {
      targetChannel: 'stable-4.22',
      arch: 'amd64',
      start: v('4.22.20'),
      target: v('5.0.3'),
    });
    if (!result.ok) throw new Error(result.error.kind);
    expect(result.value.primary.hops.map((h) => [h.to, h.sourceChannel])).toEqual([
      [v('5.0.0'), 'fast-5.0'],
      [v('5.0.3'), 'stable-5.0'],
    ]);

    const { segments } = await discoverLookahead(loader, 'stable-4.22', anchor, 'amd64');
    const option = buildTargetOptions(anchor, v('4.22.20'), segments).find((o) => o.version === v('5.0.3'));
    expect(option).toEqual({ version: v('5.0.3'), reachable: true, via: { channel: 'stable-5.0', classFallback: true } });
  });

  it('records that the preferred class is published but has no route, when a fallback enters a stream its published channel cannot', async () => {
    // Shaped like live Cincinnati in Nov 2026: stable-5.0 exists with 5.0.z only, no 4.22 upgrade sources.
    const anchor = rawGraph(['4.22.15', '4.22.20'], [[0, 1]], 'ANCHOR', ['stable-4.22', 'fast-5.0']);
    const fast50 = rawGraph(['4.22.20', '5.0.0', '5.0.1'], [[0, 1], [1, 2]], 'F50', ['fast-5.0', 'stable-5.0']);
    const stable50 = rawGraph(['5.0.0', '5.0.1'], [[0, 1]], 'S50', ['stable-5.0', 'fast-5.0']);
    const loader: GraphLoader = async (channel) => {
      if (channel === 'stable-4.22') return ok(anchor);
      if (channel === 'fast-5.0') return ok(fast50);
      if (channel === 'stable-5.0') return ok(stable50);
      return err({ kind: 'empty', channel, arch: 'amd64' });
    };

    const result = await stitchAndFindPath(loader, {
      targetChannel: 'stable-4.22',
      arch: 'amd64',
      start: v('4.22.15'),
      target: v('5.0.1'),
    });
    if (!result.ok) throw new Error(result.error.kind);
    expect(result.value.stitch.classFallbacks).toEqual([{ channel: 'fast-5.0', requestedClass: 'stable', requestedStatus: 'noRoute' }]);
  });

  it('gives up as targetNeverFound when no channel walking forward holds the target', async () => {
    const anchor = rawGraph(['4.18.0', '4.19.0', '4.20.0'], [[0, 1], [1, 2]], 'ANCHOR', ['eus-4.20', 'eus-4.22']);
    const eus422 = rawGraph(['4.20.0', '4.22.0'], [[0, 1]], 'E422');
    const channelsFetched: string[] = [];
    const loader: GraphLoader = async (channel) => {
      channelsFetched.push(channel);
      if (channel === 'eus-4.20') return ok(anchor);
      if (channel === 'eus-4.22') return ok(eus422);
      return err({ kind: 'empty', channel, arch: 'amd64' });
    };

    const result = await stitchAndFindPath(loader, {
      targetChannel: 'eus-4.20',
      arch: 'amd64',
      start: v('4.18.0'),
      target: v('4.30.0'),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('targetNeverFound');
    if (result.error.kind !== 'targetNeverFound') return;
    expect(result.error.target).toBe(v('4.30.0'));
    // Membership names nothing past 4.22, so no 4.30 channel is guessed at.
    expect(result.error.channelsTried).toEqual(['eus-4.22']);
    expect(channelsFetched).toEqual(['eus-4.20', 'eus-4.22']);
  });

  it('a genuine loadFailed during the forward walk (not a mere "channel does not exist") is surfaced when no fetched channel holds the target', async () => {
    const anchor = rawGraph(['4.18.0', '4.19.0', '4.20.0'], [[0, 1], [1, 2]], 'ANCHOR', ['eus-4.20', 'eus-4.22']);
    const loader: GraphLoader = async (channel) => {
      if (channel === 'eus-4.20') return ok(anchor);
      if (channel === 'eus-4.22') return err({ kind: 'network', message: 'boom', status: 500 });
      return err({ kind: 'empty', channel, arch: 'amd64' });
    };

    const result = await stitchAndFindPath(loader, {
      targetChannel: 'eus-4.20',
      arch: 'amd64',
      start: v('4.18.0'),
      target: v('4.22.0'),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toEqual({ kind: 'loadFailed', channel: 'eus-4.22', error: { kind: 'network', message: 'boom', status: 500 } });
  });

  it('a channel selected in the middle of a range needs both a backward and a forward walk at once', async () => {
    const back419 = rawGraph(['4.18.1', '4.19.0'], [[0, 1]], 'BACK');
    const anchor420 = rawGraph(['4.19.0', '4.20.0'], [[0, 1]], 'ANCHOR', ['stable-4.20', 'stable-4.22']);
    const fwd422 = rawGraph(['4.20.0', '4.21.0', '4.22.0'], [[0, 1], [1, 2]], 'FWD');
    const loader: GraphLoader = async (channel) => {
      if (channel === 'stable-4.20') return ok(anchor420);
      if (channel === 'stable-4.19') return ok(back419);
      if (channel === 'stable-4.22') return ok(fwd422);
      return err({ kind: 'empty', channel, arch: 'amd64' });
    };

    const result = await stitchAndFindPath(loader, {
      targetChannel: 'stable-4.20',
      arch: 'amd64',
      start: v('4.18.1'),
      target: v('4.22.0'),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.stitch.channelsUsed).toEqual(['stable-4.20', 'stable-4.19', 'stable-4.22']);
    expect(result.value.primary.versions).toEqual([v('4.18.1'), v('4.19.0'), v('4.20.0'), v('4.21.0'), v('4.22.0')]);
  });
});

describe('stitchAndFindPath — failure modes', () => {
  it('rejects a target channel that does not match the "<class>-<major>.<minor>" pattern', async () => {
    const loader: GraphLoader = async () => {
      throw new Error('loader should never be called');
    };
    const result = await stitchAndFindPath(loader, {
      targetChannel: 'not-a-real-channel-name',
      arch: 'amd64',
      start: v('4.18.0'),
      target: v('4.20.0'),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toEqual({ kind: 'invalidChannel', channel: 'not-a-real-channel-name' });
  });

  it('surfaces which channel fetch failed, per plan.md §6 ("the error names which channel fetch failed")', async () => {
    const loader: GraphLoader = async () =>
      err({ kind: 'network', message: 'boom', status: 500 } satisfies GraphError) as Result<Graph, GraphError>;
    const result = await stitchAndFindPath(loader, {
      targetChannel: 'stable-4.20',
      arch: 'amd64',
      start: v('4.18.0'),
      target: v('4.20.0'),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toEqual({
      kind: 'loadFailed',
      channel: 'stable-4.20',
      error: { kind: 'network', message: 'boom', status: 500 },
    });
  });

  it('never joins two channels through a downgrade, even when that is the only shared release', async () => {
    const anchor = rawGraph(['4.20.1', '4.20.10'], [[0, 1]], 'ANCHOR', ['stable-4.20', 'stable-4.22']);
    // The only release stable-4.22 shares with the anchor's route is 4.20.10,
    // and its only way on starts by stepping back to 4.20.5.
    const forward = rawGraph(['4.20.10', '4.20.5', '4.22.1'], [[0, 1], [1, 2]], 'FWD');
    const loader: GraphLoader = async (channel) => {
      if (channel === 'stable-4.20') return ok(anchor);
      if (channel === 'stable-4.22') return ok(forward);
      return err({ kind: 'empty', channel, arch: 'amd64' });
    };

    const result = await stitchAndFindPath(loader, {
      targetChannel: 'stable-4.20',
      arch: 'amd64',
      start: v('4.20.1'),
      target: v('4.22.1'),
    });

    expect(result.ok ? result.value.primary.versions : result.error.kind).toBe('unreachable');
  });

  it('gives up as startNeverFound once a walked-back channel holds nothing older to step back to', async () => {
    const graph418 = rawGraph(['4.0.0', '4.1.0'], [[0, 1]], 'X');
    const graph417 = rawGraph(['4.0.0'], [], 'Y');
    const channelsFetched: string[] = [];
    const loader: GraphLoader = async (channel) => {
      channelsFetched.push(channel);
      if (channel === 'stable-4.1') return ok(graph418);
      if (channel === 'stable-4.0') return ok(graph417);
      return err({ kind: 'empty', channel, arch: 'amd64' });
    };

    const result = await stitchAndFindPath(loader, {
      targetChannel: 'stable-4.1',
      arch: 'amd64',
      start: v('9.9.9'),
      target: v('4.1.0'),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('startNeverFound');
    if (result.error.kind !== 'startNeverFound') return;
    expect(result.error.channelsTried).toEqual(['stable-4.1', 'stable-4.0']);
    expect(channelsFetched).toEqual(['stable-4.1', 'stable-4.0']);
  });
});

describe('single-graph alternates', () => {
  it('offers alternates distinct from the primary on screen (candidate-4.20 fixture)', async () => {
    const parsed = parseRawGraph(loadFixture('candidate-4.20.json'), { channel: 'candidate-4.20', arch: 'amd64' });
    if (!parsed.ok) throw new Error('fixture did not parse');
    const loader: GraphLoader = async () => ok(parsed.value);

    const result = await stitchAndFindPath(loader, { targetChannel: 'candidate-4.20', arch: 'amd64', start: v('4.18.14'), target: v('4.20.0-ec.2') });

    if (!result.ok) throw new Error(result.error.kind);
    const shown = [result.value.primary, ...result.value.alternates].map((p) => p.versions.join(' > '));
    expect(new Set(shown).size).toBe(shown.length);
    expect(shown.some((route) => route.includes('4.19.0-rc.2'))).toBe(true);
    expect(shown.some((route) => route.includes('4.19.0-rc.3'))).toBe(true);
  });
});

describe('node metadata follows hop provenance', () => {
  it('takes a hop\'s --to-image digest from the graph that supplied the hop, not a graph only the lower-risk route uses', async () => {
    const anchor = fx.graph([], { nodes: ['4.20.0'] });
    const stable421 = fx.graph([['4.20.0', '4.21.2']]);
    const stable422 = fx.graph([], { risks: [{ from: '4.20.0', to: '4.22.0', name: 'R' }] });
    // Only the lower-risk route walks stable-4.23, and it holds 4.22.0 under another digest.
    const stable423 = fx.graph([['4.21.2', '4.22.0']], { nodes: ['4.21.0'] });
    const segment = (channel: string, graph: Graph) => ({ channel, graph, classFallback: false as const });
    const lookahead = [segment('stable-4.21', stable421), segment('stable-4.22', stable422), segment('stable-4.23', stable423)];
    const noFetch: GraphLoader = async (channel) => {
      throw new Error(`unexpected fetch of ${channel}`);
    };

    const result = await stitchAndFindPath(noFetch, {
      targetChannel: 'stable-4.20',
      arch: 'amd64',
      start: v('4.20.0'),
      target: v('4.22.0'),
      anchor: { graph: anchor, lookahead: { segments: lookahead, channelsTried: lookahead.map((s) => s.channel) } },
    });

    if (!result.ok) throw new Error(result.error.kind);
    expect(result.value.primary.hops.map((h) => h.sourceChannel)).toEqual(['stable-4.22']);
    expect(result.value.riskComparison?.route?.hops.map((h) => h.sourceChannel)).toEqual(['stable-4.21', 'stable-4.23']);
    const [command] = buildHopCommands(result.value.primary, 'stable-4.20', result.value.nodeInfo, { channelNames: [], multiGraph: true });
    const digest = stable422.nodes.find((n) => n.version === '4.22.0')?.payload as string;
    expect(digest).not.toBe(stable423.nodes.find((n) => n.version === '4.22.0')?.payload);
    expect(command?.upgradeToImage).toBe(`oc adm upgrade --to-image=${digest} --allow-explicit-upgrade`);
  });
});
