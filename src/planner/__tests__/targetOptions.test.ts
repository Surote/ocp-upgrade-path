import { describe, expect, it } from 'vitest';
import type { Version } from '../../graph/types';
import { buildGraph } from '../../test-utils/buildGraph';
import { buildStartOptions, buildTargetOptions } from '../targetOptions';

function v(s: string): Version {
  return s as Version;
}

describe('buildStartOptions', () => {
  it('lists every node, newest first, using semver comparison (not string sort)', () => {
    const graph = buildGraph(['4.18.2', '4.9.0', '4.18.10']);
    expect(buildStartOptions(graph)).toEqual([v('4.18.10'), v('4.18.2'), v('4.9.0')]);
  });
});

describe('buildTargetOptions', () => {
  it('excludes the start version itself', () => {
    const graph = buildGraph(['1.0.0', '2.0.0'], [[0, 1]]);
    const options = buildTargetOptions(graph, v('1.0.0'));
    expect(options.map((o) => o.version)).not.toContain(v('1.0.0'));
  });

  it('marks a reachable, newer version enabled with no reason', () => {
    const graph = buildGraph(['1.0.0', '2.0.0'], [[0, 1]]);
    const options = buildTargetOptions(graph, v('1.0.0'));
    const target = options.find((o) => o.version === v('2.0.0'));
    expect(target).toEqual({ version: v('2.0.0'), disabled: false });
  });

  it('disables an older version with a distinct reason (downgrade, not "unreachable")', () => {
    const graph = buildGraph(['1.0.0', '2.0.0'], [[0, 1]]);
    const options = buildTargetOptions(graph, v('2.0.0'));
    const target = options.find((o) => o.version === v('1.0.0'));
    expect(target?.disabled).toBe(true);
    expect(target?.reason).toMatch(/older/i);
  });

  it('disables a newer-but-unreachable version with a distinct reason', () => {
    // 1.0.0 -> 1.5.0, and a disconnected 1.9.0 -> 2.0.0 island.
    const graph = buildGraph(['1.0.0', '1.5.0', '1.9.0', '2.0.0'], [
      [0, 1],
      [2, 3],
    ]);
    const options = buildTargetOptions(graph, v('1.0.0'));
    const target = options.find((o) => o.version === v('2.0.0'));
    expect(target?.disabled).toBe(true);
    expect(target?.reason).toMatch(/not reachable/i);
  });

  it('is sorted newest first among the (non-start) versions', () => {
    const graph = buildGraph(['1.0.0', '1.1.0', '1.2.0'], [
      [0, 1],
      [0, 2],
    ]);
    const options = buildTargetOptions(graph, v('1.0.0'));
    expect(options.map((o) => o.version)).toEqual([v('1.2.0'), v('1.1.0')]);
  });

  it('runs one reachability traversal per call rather than a per-candidate search -- sanity check via a larger graph', () => {
    const versions = Array.from({ length: 50 }, (_, i) => `1.${i}.0`);
    const edges: Array<readonly [number, number]> = [];
    for (let i = 0; i < versions.length - 1; i += 1) edges.push([i, i + 1]);
    const graph = buildGraph(versions, edges);
    const options = buildTargetOptions(graph, v('1.0.0'));
    expect(options).toHaveLength(49);
    expect(options.every((o) => !o.disabled)).toBe(true);
  });
});
