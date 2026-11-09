import { describe, expect, it } from 'vitest';
import { parseRawGraph } from '../../graph/parse';
import type { Graph, Version } from '../../graph/types';
import { err, ok, type Result } from '../../lib/result';
import type { GraphError } from '../../graph/errors';
import { stitchAndFindPath } from '../stitch';
import type { GraphLoader } from '../types';

function v(s: string): Version {
  return s as Version;
}

/** Builds a synthetic Graph via the real parse boundary, with a distinguishable payload per node so tests can prove *which* graph's copy of an overlapping node won. */
function rawGraph(nodeVersions: readonly string[], edges: ReadonlyArray<readonly [number, number]>, payloadTag: string): Graph {
  const raw = {
    version: 1,
    nodes: nodeVersions.map((version, i) => ({
      version,
      payload: `quay.io/openshift-release-dev/ocp-release@sha256:${payloadTag}-${i}`,
      metadata: { url: `https://access.redhat.com/errata/${payloadTag}-${i}` },
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
    const anchor = rawGraph(['4.18.0', '4.19.0', '4.20.0'], [[0, 1], [1, 2]], 'ANCHOR');
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

  // plan.md §6 "Where the switch is attributed matters": several *consecutive*
  // stations can all be genuine members of the destination channel before
  // the layered DP's own boundary. The DP here is only able to route the
  // final two hops (4.20.9 -> 4.21.0 -> 4.22.0) through the forward
  // channel -- it has no edges starting from the earlier shared stations
  // 4.20.0 or 4.20.5 -- so a naive "last station before the crossing hop"
  // attribution (i.e. just moving the switch one station earlier than the
  // old off-by-one bug, without a real earliest-member scan) would still
  // land on 4.20.9 and get this wrong. The correct answer is 4.20.0: the
  // earliest station on the path that is *itself* a member of `eus-4.22`,
  // per the real fetched membership data, regardless of which segment's
  // edges the DP happened to use to actually traverse the intervening hops.
  it('attributes the switch to the earliest of several consecutive shared stations, not the DP\'s own (later, cost/edge-driven) boundary', async () => {
    // eus-4.20: a straight chain through the whole range, including three
    // 4.20.x releases that are *also* members of eus-4.22 below.
    const anchor = rawGraph(
      ['4.18.0', '4.19.0', '4.20.0', '4.20.5', '4.20.9'],
      [[0, 1], [1, 2], [2, 3], [3, 4]],
      'ANCHOR',
    );
    // eus-4.22: lists the same three 4.20.x releases as real members (so
    // they're genuinely reachable channel switch targets), but its own
    // edges only start from the last one, 4.20.9 -- exactly the shape that
    // forces the DP's own boundary later than the true earliest member.
    const forward = rawGraph(
      ['4.20.0', '4.20.5', '4.20.9', '4.21.0', '4.22.0'],
      [[2, 3], [3, 4]],
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

    // The switch is attributed to 4.20.0 -- the earliest shared station --
    // even though the DP itself could only actually walk the 4.20.0 -> 4.20.5
    // -> 4.20.9 hops using eus-4.20's own edges (eus-4.22 has none starting
    // there). A regression to "the DP's own boundary" (4.20.9) or to "one
    // station earlier than the old bug" (still 4.20.9 here, since the DP's
    // boundary and the old off-by-one-arrival station coincide only when
    // there's a single shared station -- this fixture deliberately has
    // three) would fail this assertion.
    const sourceChannels = result.value.primary.hops.map((h) => h.sourceChannel);
    expect(sourceChannels).toEqual(['eus-4.20', 'eus-4.20', 'eus-4.22', 'eus-4.22', 'eus-4.22', 'eus-4.22']);
  });

  it('falls back to stable at a minor where the anchor\'s own class has no channel (EUS odd minors), and records the fallback', async () => {
    const anchor = rawGraph(['4.18.0', '4.19.0', '4.20.0'], [[0, 1], [1, 2]], 'ANCHOR');
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
    expect(result.value.stitch.classFallbacks).toEqual([{ channel: 'stable-4.21', requestedClass: 'eus' }]);
    expect(result.value.primary.hops.at(-1)?.sourceChannel).toBe('stable-4.21');
  });

  it('walks through multiple forward minors, falling back to stable only at the minor that needs it, until it reaches back to the anchor', async () => {
    const anchor = rawGraph(['4.18.0', '4.19.0', '4.20.0'], [[0, 1], [1, 2]], 'ANCHOR');
    const eus422 = rawGraph(['4.20.0', '4.21.0', '4.22.0'], [[0, 1], [1, 2]], 'E422');
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
    // Walks target-minor-first, decrementing toward the anchor: 4.23 (falls
    // back to stable) then 4.22 (same class succeeds and finally overlaps
    // the anchor's own 4.20.x band) -- exactly mirroring the backward walk's
    // one-minor-at-a-time shape, just in the opposite direction.
    expect(calls).toEqual(['eus-4.20', 'eus-4.23', 'stable-4.23', 'eus-4.22']);
    expect(result.value.stitch.channelsUsed).toEqual(['eus-4.20', 'stable-4.23', 'eus-4.22']);
    expect(result.value.stitch.classFallbacks).toEqual([{ channel: 'stable-4.23', requestedClass: 'eus' }]);
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

  it('gives up as targetNeverFound when no channel walking forward ever reaches back to the anchor', async () => {
    const anchor = rawGraph(['4.18.0', '4.19.0', '4.20.0'], [[0, 1], [1, 2]], 'ANCHOR');
    const channelsFetched: string[] = [];
    const loader: GraphLoader = async (channel) => {
      channelsFetched.push(channel);
      if (channel === 'eus-4.20') return ok(anchor);
      return err({ kind: 'empty', channel, arch: 'amd64' }); // nothing beyond the anchor ever exists in this scenario
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
    // No class exists at 4.30 -- the walk gives up at the very first stream
    // rather than guessing further.
    expect(result.error.channelsTried).toEqual(['eus-4.30', 'stable-4.30', 'fast-4.30', 'candidate-4.30']);
    expect(channelsFetched).toEqual(['eus-4.20', 'eus-4.30', 'stable-4.30', 'fast-4.30', 'candidate-4.30']);
  });

  it('a genuine loadFailed during the forward walk (not a mere "channel does not exist") is surfaced immediately', async () => {
    const anchor = rawGraph(['4.18.0', '4.19.0', '4.20.0'], [[0, 1], [1, 2]], 'ANCHOR');
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
    const anchor420 = rawGraph(['4.19.0', '4.20.0'], [[0, 1]], 'ANCHOR');
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
