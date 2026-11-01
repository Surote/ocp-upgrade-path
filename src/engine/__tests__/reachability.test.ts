import { describe, expect, it } from 'vitest';
import { parseRawGraph } from '../../graph/parse';
import type { Version } from '../../graph/types';
import { buildGraph } from '../../test-utils/buildGraph';
import { loadFixture } from '../../test-utils/fixtures';
import { reachableFrom } from '../reachability';

function v(s: string): Version {
  return s as Version;
}

describe('reachableFrom — synthetic graphs', () => {
  it('includes the start version itself (zero-hop reachability)', () => {
    const graph = buildGraph(['1.0.0'], []);
    expect(reachableFrom(graph, v('1.0.0'))).toEqual(new Set([v('1.0.0')]));
  });

  it('includes every version downstream of start along forward edges, transitively', () => {
    const graph = buildGraph(['1.0.0', '1.1.0', '1.2.0', '2.0.0'], [
      [0, 1],
      [1, 2],
      [2, 3],
    ]);
    const reachable = reachableFrom(graph, v('1.0.0'));
    expect(reachable).toEqual(new Set([v('1.0.0'), v('1.1.0'), v('1.2.0'), v('2.0.0')]));
  });

  it('excludes a version only reachable by walking an edge backwards', () => {
    const graph = buildGraph(['1.0.0', '2.0.0'], [[0, 1]]);
    expect(reachableFrom(graph, v('2.0.0'))).toEqual(new Set([v('2.0.0')]));
  });

  it('excludes a disconnected island entirely', () => {
    const graph = buildGraph(['1.0.0', '1.5.0', '9.0.0', '9.5.0'], [
      [0, 1],
      [2, 3],
    ]);
    const reachable = reachableFrom(graph, v('1.0.0'));
    expect(reachable).toEqual(new Set([v('1.0.0'), v('1.5.0')]));
  });

  it('returns an empty set when start is not a node in the graph at all', () => {
    const graph = buildGraph(['1.0.0', '2.0.0'], [[0, 1]]);
    expect(reachableFrom(graph, v('9.9.9'))).toEqual(new Set());
  });

  it('handles a diamond (multiple paths converging) without duplicating or missing the convergence node', () => {
    const graph = buildGraph(['1.0.0', '1.1.0', '1.2.0', '2.0.0'], [
      [0, 1],
      [0, 2],
      [1, 3],
      [2, 3],
    ]);
    const reachable = reachableFrom(graph, v('1.0.0'));
    expect(reachable).toEqual(new Set([v('1.0.0'), v('1.1.0'), v('1.2.0'), v('2.0.0')]));
  });

  it('is unaffected by an unexpected cycle -- terminates and does not revisit', () => {
    const graph = buildGraph(['1.0.0', '1.1.0', '1.2.0'], [
      [0, 1],
      [1, 2],
      [2, 0], // cycle back to start
    ]);
    const reachable = reachableFrom(graph, v('1.0.0'));
    expect(reachable).toEqual(new Set([v('1.0.0'), v('1.1.0'), v('1.2.0')]));
  });
});

describe('reachableFrom — pinned stable-4.20 fixture', () => {
  function loadStable420() {
    const result = parseRawGraph(loadFixture('stable-4.20.json'), { channel: 'stable-4.20', arch: 'amd64' });
    if (!result.ok) throw result.error;
    return result.value;
  }

  it('4.20.32 is reachable from 4.18.2 -- matches the verified live example (plan.md §1)', () => {
    const reachable = reachableFrom(loadStable420(), v('4.18.2'));
    expect(reachable.has(v('4.20.32'))).toBe(true);
  });

  it('a node present in the graph but with no forward edge from 4.18.2 is correctly excluded', () => {
    // 4.18.1 is a real node in this fixture with no directed path from
    // 4.18.2, unconditional or conditional (verified against the raw fixture
    // data directly). 4.18.5 is reachable, but only via a conditional update.
    const reachable = reachableFrom(loadStable420(), v('4.18.2'));
    expect(reachable.has(v('4.18.1'))).toBe(false);
    expect(reachable.has(v('4.18.5'))).toBe(true);
  });

  it('agrees with findPathsInGraph on a sample of reachable/unreachable versions', async () => {
    const { findPathsInGraph } = await import('../pathfinder');
    const graph = loadStable420();
    const reachable = reachableFrom(graph, v('4.18.2'));

    for (const candidate of ['4.20.32', '4.19.40', '4.18.5', '4.18.1', '4.20.1'] as const) {
      const target = v(candidate);
      const pathResult = findPathsInGraph(graph, v('4.18.2'), target);
      expect(reachable.has(target)).toBe(pathResult.ok);
    }
  });
});
