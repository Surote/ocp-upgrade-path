import { describe, expect, it } from 'vitest';
import { parseRawGraph } from '../../graph/parse';
import type { Version } from '../../graph/types';
import { buildGraph } from '../../test-utils/buildGraph';
import { loadFixture } from '../../test-utils/fixtures';
import { findPathsInGraph } from '../pathfinder';

function v(s: string): Version {
  return s as Version;
}

function loadStable420() {
  const result = parseRawGraph(loadFixture('stable-4.20.json'), { channel: 'stable-4.20', arch: 'amd64' });
  if (!result.ok) throw result.error;
  return result.value;
}

describe('findPathsInGraph — the verified live example (plan.md §1)', () => {
  it('4.18.2 -> 4.20.32 in stable-4.20 is a 3-hop, 0-risk path landing on 4.19.40 via the highest-patch 4.18.z available', () => {
    // plan.md §1 states the live-verified path as
    //   4.18.2 -> 4.18.49 -> 4.19.40 -> 4.20.32
    // and this pinned fixture DOES contain exactly that risk-free 3-hop path.
    // But the fixture also contains 4.18.50 and 4.18.51 -- two z-stream
    // patches for 4.18 that are newer than 4.18.49 -- each with its own
    // risk-free edge from 4.18.2, and 4.18.50 also has a risk-free edge to
    // 4.19.40 (verified: 4.18.2->4.18.50, 4.18.50->4.19.40, and
    // 4.19.40->4.20.32 are all present and carry no conditionalEdges risk
    // entry). Per plan.md §4's cost tuple, the third component is an explicit
    // tie-break for "higher patch level", applied among paths already tied on
    // (hops, risk weight) -- and 4.18.2->4.18.50->4.19.40->4.20.32 is exactly
    // such a path, with a strictly higher patch sum (50+40+32=122) than the
    // plan's stated answer (49+40+32=121). 4.18.51 does not extend this
    // further: its only edge into 4.19 lands on 4.19.41, which has no edge to
    // 4.20.32, so it cannot complete a 3-hop path at all.
    //
    // This is investigated and intentional, not an unexamined disagreement:
    // Cincinnati graphs are live and change on Red Hat's own release cadence
    // (plan.md's closing paragraph says exactly this), and 4.18.50/4.18.51
    // most plausibly did not exist in the channel at the moment plan.md's
    // example was verified against the live API, but do exist in this later
    // pinned fixture snapshot. Applying the literal, sound cost tuple to the
    // graph this test actually has in hand correctly prefers the newer patch.
    // See the implementation report for the full write-up.
    const graph = loadStable420();
    const result = findPathsInGraph(graph, v('4.18.2'), v('4.20.32'));

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const { primary } = result.value;
    expect(primary.versions).toEqual([v('4.18.2'), v('4.18.50'), v('4.19.40'), v('4.20.32')]);
    expect(primary.cost.hops).toBe(3);
    expect(primary.cost.riskWeight).toBe(0);
    expect(primary.hops.every((h) => h.risks.length === 0)).toBe(true);
    expect(primary.riskSummary).toEqual([]);

    // The exact path plan.md's live verification names is still present in
    // this fixture and is risk-free, but it lands on the same 4.19.z as the
    // primary (4.19.40) -- so per the waypoint-alternates definition (grouped
    // by *which minor-4.19 release the path lands on*, not which 4.18.z it
    // took to get there), it is correctly collapsed into the primary's own
    // waypoint group rather than surfaced as a separate alternate. It lost
    // only the patch-level tie-break within that group, one confirmed here directly.
    const via49 = findPathsInGraph(graph, v('4.18.49'), v('4.20.32'));
    if (!via49.ok) throw via49.error;
    expect(via49.value.primary.versions).toEqual([v('4.18.49'), v('4.19.40'), v('4.20.32')]);
  });

  it('reports up to 2 waypoint alternates, distinct from the primary by which 4.19.z they land on', () => {
    const graph = loadStable420();
    const result = findPathsInGraph(graph, v('4.18.2'), v('4.20.32'));
    if (!result.ok) throw result.error;

    const { primary, alternates } = result.value;
    expect(alternates.length).toBeLessThanOrEqual(2);
    const primaryLanding = primary.versions.find((ver) => ver.startsWith('4.19.'));
    for (const alt of alternates) {
      const altLanding = alt.versions.find((ver) => ver.startsWith('4.19.'));
      expect(altLanding).not.toBe(primaryLanding);
      // alternates are never cheaper than the primary
      expect(
        alt.cost.hops > primary.cost.hops ||
          (alt.cost.hops === primary.cost.hops && alt.cost.riskWeight >= primary.cost.riskWeight),
      ).toBe(true);
    }
    // alternates are sorted best-first
    for (let i = 1; i < alternates.length; i += 1) {
      const a = alternates[i - 1]?.cost;
      const b = alternates[i]?.cost;
      expect(a).toBeDefined();
      expect(b).toBeDefined();
      if (!a || !b) continue;
      const cmp = a.hops - b.hops || a.riskWeight - b.riskWeight || a.tieBreak - b.tieBreak;
      expect(cmp).toBeLessThanOrEqual(0);
    }
  });
});

describe('findPathsInGraph — cost tuple ordering', () => {
  it('prefers fewer hops over lower risk weight (hops dominate)', () => {
    // A: start -(risky)-> target  [1 hop, risky]
    // B: start -> mid -> target   [2 hops, risk-free]
    // Minimal hop count wins even though A is risk-free... invert: make the
    // 1-hop edge risky and the 2-hop route clean, and assert the 1-hop
    // (riskier) path still wins because hop count is minimised first.
    const graph = buildGraph(['1.0.0', '1.1.0', '1.2.0', '2.0.0'], [
      [0, 3], // 1.0.0 -> 2.0.0 direct
      [0, 1], // 1.0.0 -> 1.1.0
      [1, 2], // 1.1.0 -> 1.2.0
      [2, 3], // 1.2.0 -> 2.0.0
    ]);
    const result = findPathsInGraph(graph, v('1.0.0'), v('2.0.0'));
    if (!result.ok) throw result.error;
    expect(result.value.primary.versions).toEqual([v('1.0.0'), v('2.0.0')]);
    expect(result.value.primary.cost.hops).toBe(1);
  });

  it('among equal-hop paths, prefers lower risk weight over patch level', () => {
    const raw = {
      version: 1,
      nodes: [
        { version: '1.0.0', payload: 'p0' },
        { version: '1.0.5', payload: 'p1' }, // higher patch, but risky
        { version: '1.0.1', payload: 'p2' }, // lower patch, risk-free
        { version: '2.0.0', payload: 'p3' },
      ],
      edges: [
        [0, 1],
        [0, 2],
        [1, 3],
        [2, 3],
      ],
      conditionalEdges: [
        {
          edges: [{ from: '1.0.5', to: '2.0.0' }],
          risks: [{ url: 'u', name: 'Risky', message: 'm', matchingRules: [{ type: 'Always' }] }],
        },
      ],
    };
    const parsed = parseRawGraph(raw, { channel: 'test', arch: 'amd64' });
    if (!parsed.ok) throw parsed.error;

    const result = findPathsInGraph(parsed.value, v('1.0.0'), v('2.0.0'));
    if (!result.ok) throw result.error;
    // Both 1.0.5 and 1.0.1 reach 2.0.0 in 2 hops; 1.0.1's edge is risk-free.
    expect(result.value.primary.versions).toEqual([v('1.0.0'), v('1.0.1'), v('2.0.0')]);
  });

  it('among equal-hop, equal-risk paths, prefers the higher patch level', () => {
    const graph = buildGraph(['1.0.0', '1.0.5', '1.0.21', '2.0.0'], [
      [0, 1], // 1.0.0 -> 1.0.5
      [0, 2], // 1.0.0 -> 1.0.21
      [1, 3],
      [2, 3],
    ]);
    const result = findPathsInGraph(graph, v('1.0.0'), v('2.0.0'));
    if (!result.ok) throw result.error;
    expect(result.value.primary.versions).toEqual([v('1.0.0'), v('1.0.21'), v('2.0.0')]);
  });

  it('hop count dominates the tie-break component no matter its magnitude -- a regression case for the comparator', () => {
    // A: start -> target direct (1 hop, patch 1 -- tiny tie-break contribution)
    // B: start -> mid -> target (2 hops, landing on an enormous patch number,
    //    so its summed tie-break component is *far* more negative than A's).
    // If the comparator ever regressed into treating the tie-break as more
    // significant than hop count (e.g. summed into one scalar instead of
    // compared lexicographically), B would incorrectly win.
    const graph = buildGraph(['1.0.0', '1.0.999999', '1.0.1'], [
      [0, 2], // 1.0.0 -> 1.0.1 (1 hop)
      [0, 1], // 1.0.0 -> 1.0.999999
      [1, 2], // 1.0.999999 -> 1.0.1 (2nd hop of the 2-hop route)
    ]);
    const result = findPathsInGraph(graph, v('1.0.0'), v('1.0.1'));
    if (!result.ok) throw result.error;
    expect(result.value.primary.versions).toEqual([v('1.0.0'), v('1.0.1')]);
    expect(result.value.primary.cost.hops).toBe(1);
  });
});

describe('findPathsInGraph — waypoint alternates (synthetic)', () => {
  it('offers the best path per distinct intermediate-minor waypoint, capped at 3 total', () => {
    // OpenShift's "minor" is the middle field of major.minor.patch (4.Y.Z) --
    // keep major fixed and vary Y, mirroring the real versioning scheme.
    // start(4.18) -> {4.19.a, 4.19.b, 4.19.c, 4.19.d} -> target(4.20), each a distinct 1-minor waypoint.
    const graph = buildGraph(
      ['4.18.0', '4.19.10', '4.19.20', '4.19.30', '4.19.40', '4.20.0'],
      [
        [0, 1],
        [0, 2],
        [0, 3],
        [0, 4],
        [1, 5],
        [2, 5],
        [3, 5],
        [4, 5],
      ],
    );
    const result = findPathsInGraph(graph, v('4.18.0'), v('4.20.0'));
    if (!result.ok) throw result.error;

    expect(result.value.primary.versions).toEqual([v('4.18.0'), v('4.19.40'), v('4.20.0')]); // highest patch wins the primary
    expect(result.value.alternates).toHaveLength(2); // capped at 2 alternates (3 total with primary)
    const landings = result.value.alternates.map((p) => p.versions[1]);
    expect(landings).toEqual([v('4.19.30'), v('4.19.20')]); // next-best waypoints, in order
  });

  it('returns no alternates when there is no intermediate minor (adjacent minors)', () => {
    const graph = buildGraph(['4.19.0', '4.20.0'], [[0, 1]]);
    const result = findPathsInGraph(graph, v('4.19.0'), v('4.20.0'));
    if (!result.ok) throw result.error;
    expect(result.value.alternates).toEqual([]);
  });

  it('returns no alternates for a same-minor upgrade', () => {
    const graph = buildGraph(['1.0.0', '1.0.9'], [[0, 1]]);
    const result = findPathsInGraph(graph, v('1.0.0'), v('1.0.9'));
    if (!result.ok) throw result.error;
    expect(result.value.alternates).toEqual([]);
  });
});

describe('findPathsInGraph — no-path diagnosis (plan.md §4)', () => {
  it('reports startNotFound when the start version is not a node in the graph', () => {
    const graph = buildGraph(['1.0.0', '2.0.0'], [[0, 1]]);
    const result = findPathsInGraph(graph, v('9.9.9'), v('2.0.0'));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toEqual({ kind: 'startNotFound', start: v('9.9.9') });
  });

  it('reports targetOlder when the target is semver-older than the start', () => {
    const graph = buildGraph(['1.0.0', '2.0.0'], [[0, 1]]);
    const result = findPathsInGraph(graph, v('2.0.0'), v('1.0.0'));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toEqual({ kind: 'targetOlder', start: v('2.0.0'), target: v('1.0.0') });
  });

  it('reports unreachable with the nearest reachable version when the target exists but has no path from start', () => {
    // 1.0.0 -> 1.5.0, and a disconnected 1.9.0 -> 2.0.0 island.
    const graph = buildGraph(['1.0.0', '1.5.0', '1.9.0', '2.0.0'], [
      [0, 1],
      [2, 3],
    ]);
    const result = findPathsInGraph(graph, v('1.0.0'), v('2.0.0'));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('unreachable');
    if (result.error.kind !== 'unreachable') return;
    expect(result.error.nearestReachable).toBe(v('1.5.0'));
  });

  it('reports unreachable (not a crash) when the target version is not a node in the graph at all', () => {
    const graph = buildGraph(['1.0.0', '1.5.0'], [[0, 1]]);
    const result = findPathsInGraph(graph, v('1.0.0'), v('9.9.9'));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('unreachable');
    if (result.error.kind !== 'unreachable') return;
    expect(result.error.nearestReachable).toBe(v('1.5.0'));
  });

  it('nearestReachable prefers the highest reachable version at or below target', () => {
    const graph = buildGraph(['1.0.0', '1.4.0', '1.6.0'], [
      [0, 1],
      [0, 2],
    ]);
    // target 1.5.0 doesn't exist; 1.4.0 (below) and 1.6.0 (above) are both reachable.
    const result = findPathsInGraph(graph, v('1.0.0'), v('1.5.0'));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('unreachable');
    if (result.error.kind !== 'unreachable') return;
    expect(result.error.nearestReachable).toBe(v('1.4.0'));
  });
});

describe('findPathsInGraph — trivial and edge cases', () => {
  it('returns a 0-hop path when start equals target', () => {
    const graph = buildGraph(['1.0.0', '2.0.0'], [[0, 1]]);
    const result = findPathsInGraph(graph, v('1.0.0'), v('1.0.0'));
    if (!result.ok) throw result.error;
    expect(result.value.primary).toEqual({
      versions: [v('1.0.0')],
      hops: [],
      cost: { hops: 0, riskWeight: 0, tieBreak: 0 },
      riskSummary: [],
    });
    expect(result.value.alternates).toEqual([]);
  });

  it('stays correct in the presence of a cycle rather than assuming a DAG', () => {
    // 1.0.0 -> 1.1.0 -> 1.0.0 (cycle) and 1.1.0 -> 2.0.0.
    const graph = buildGraph(['1.0.0', '1.1.0', '2.0.0'], [
      [0, 1],
      [1, 0],
      [1, 2],
    ]);
    const result = findPathsInGraph(graph, v('1.0.0'), v('2.0.0'));
    if (!result.ok) throw result.error;
    expect(result.value.primary.versions).toEqual([v('1.0.0'), v('1.1.0'), v('2.0.0')]);
    expect(result.value.primary.cost.hops).toBe(2);
  });
});

describe('findPathsInGraph — conditional edges (live stable-4.22)', () => {
  // Live Cincinnati lists conditional updates only in `conditionalEdges`,
  // never also in `edges`; in stable-4.22 every 4.21 -> 4.22 update is conditional.
  function loadStable422() {
    const result = parseRawGraph(loadFixture('stable-4.22.json'), { channel: 'stable-4.22', arch: 'amd64' });
    if (!result.ok) throw result.error;
    return result.value;
  }

  it('plans through a conditional-only update and reports its risks', () => {
    const result = findPathsInGraph(loadStable422(), v('4.21.0'), v('4.22.20'));
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    const crossing = result.value.primary.hops.find((h) => h.from.startsWith('4.21.') && h.to.startsWith('4.22.'));
    expect(crossing?.risks.length).toBeGreaterThan(0);
    expect(result.value.primary.riskSummary.length).toBeGreaterThan(0);
  });

  it('still prefers an unconditional update over an equally short conditional one', () => {
    const raw = {
      version: 1,
      nodes: [
        { version: '1.0.0', payload: 'p0' },
        { version: '1.0.9', payload: 'p1' },
        { version: '1.0.1', payload: 'p2' },
        { version: '2.0.0', payload: 'p3' },
      ],
      edges: [
        [0, 1],
        [0, 2],
        [2, 3],
      ],
      conditionalEdges: [
        {
          edges: [{ from: '1.0.9', to: '2.0.0' }],
          risks: [{ url: 'u', name: 'Risky', message: 'm', matchingRules: [{ type: 'PromQL', promql: { promql: 'up' } }] }],
        },
      ],
    };
    const parsed = parseRawGraph(raw, { channel: 'test', arch: 'amd64' });
    if (!parsed.ok) throw parsed.error;
    const result = findPathsInGraph(parsed.value, v('1.0.0'), v('2.0.0'));
    if (!result.ok) throw result.error;
    expect(result.value.primary.versions).toEqual([v('1.0.0'), v('1.0.1'), v('2.0.0')]);
    expect(result.value.alternates.map((p) => p.versions)).toEqual([]);
  });
});
