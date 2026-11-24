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

describe('buildTargetOptions -- selected channel only', () => {
  it('offers only versions newer than the start: the start itself and older versions are omitted', () => {
    const graph = buildGraph(['1.0.0', '2.0.0', '3.0.0'], [[0, 1], [1, 2]]);
    expect(buildTargetOptions(graph, v('2.0.0'), []).map((o) => o.version)).toEqual([v('3.0.0')]);
  });

  it('offers a build of the start release, equal to it in SemVer precedence, when the graph has the hop', () => {
    const graph = buildGraph(['4.22.1-rc.1', '4.22.1-rc.1+build.1'], [[0, 1]]);
    expect(buildTargetOptions(graph, v('4.22.1-rc.1'), [])).toEqual([{ version: v('4.22.1-rc.1+build.1'), reachable: true, via: undefined }]);
  });

  it('marks a reachable, newer version reachable with no channel change', () => {
    const graph = buildGraph(['1.0.0', '2.0.0'], [[0, 1]]);
    expect(buildTargetOptions(graph, v('1.0.0'), [])).toEqual([{ version: v('2.0.0'), reachable: true, via: undefined }]);
  });

  it('keeps a newer-but-unreachable version, marked unreachable', () => {
    // 1.0.0 -> 1.5.0, and a disconnected 1.9.0 -> 2.0.0 island.
    const graph = buildGraph(['1.0.0', '1.5.0', '1.9.0', '2.0.0'], [
      [0, 1],
      [2, 3],
    ]);
    const options = buildTargetOptions(graph, v('1.0.0'), []);
    expect(options.find((o) => o.version === v('2.0.0'))?.reachable).toBe(false);
  });

  it('is sorted newest first, semver not lexical', () => {
    const graph = buildGraph(['1.0.0', '1.9.0', '1.10.0', '1.10.0-rc.1'], [
      [0, 1],
      [0, 2],
      [0, 3],
    ]);
    expect(buildTargetOptions(graph, v('1.0.0'), []).map((o) => o.version)).toEqual([v('1.10.0'), v('1.10.0-rc.1'), v('1.9.0')]);
  });
});

describe('buildTargetOptions -- with look-ahead channels', () => {
  it('merges look-ahead versions into one newest-first list, so 5.x sorts above in-channel 4.22.x', () => {
    const anchor = buildGraph(['4.22.0', '4.22.1', '4.22.5'], [[0, 1], [1, 2]]);
    const seg50 = buildGraph(['4.22.5', '5.0.0', '5.0.2'], [[0, 1], [1, 2]]);
    const options = buildTargetOptions(anchor, v('4.22.0'), [{ channel: 'fast-5.0', graph: seg50, classFallback: true }]);
    expect(options.map((o) => [o.version, o.via?.channel])).toEqual([
      [v('5.0.2'), 'fast-5.0'],
      [v('5.0.0'), 'fast-5.0'],
      [v('4.22.5'), undefined],
      [v('4.22.1'), undefined],
    ]);
  });

  it('lists a version that is in both the selected channel and a look-ahead channel once, as in-channel', () => {
    const anchor = buildGraph(['4.18.0', '4.20.0'], [[0, 1]]);
    const forward = buildGraph(['4.20.0', '4.22.0'], [[0, 1]]);
    const options = buildTargetOptions(anchor, v('4.18.0'), [{ channel: 'eus-4.22', graph: forward, classFallback: false }]);
    expect(options.filter((o) => o.version === v('4.20.0'))).toEqual([{ version: v('4.20.0'), reachable: true, via: undefined }]);
  });

  it('marks a look-ahead version reachable through a start-reachable version the graphs share, and names its channel', () => {
    const anchor = buildGraph(['4.18.0', '4.19.0', '4.20.0'], [[0, 1], [1, 2]]);
    const forward = buildGraph(['4.20.0', '4.21.0', '4.22.9'], [[0, 1], [1, 2]]);
    const options = buildTargetOptions(anchor, v('4.18.0'), [{ channel: 'eus-4.22', graph: forward, classFallback: false }]);
    expect(options.find((o) => o.version === v('4.22.9'))).toEqual({
      version: v('4.22.9'),
      reachable: true,
      via: { channel: 'eus-4.22', classFallback: false },
    });
  });

  it('marks a look-ahead version unreachable when its channel shares no start-reachable version', () => {
    const anchor = buildGraph(['4.18.0', '4.19.0'], [[0, 1]]);
    const forward = buildGraph(['4.20.5', '4.21.0'], [[0, 1]]);
    const options = buildTargetOptions(anchor, v('4.18.0'), [{ channel: 'stable-4.21', graph: forward, classFallback: false }]);
    expect(options.filter((o) => o.via).every((o) => !o.reachable)).toBe(true);
  });

  it('carries the class fallback flag so the UI can call it out', () => {
    const anchor = buildGraph(['4.18.0', '4.20.0'], [[0, 1]]);
    const forward = buildGraph(['4.20.0', '4.21.5'], [[0, 1]]);
    const options = buildTargetOptions(anchor, v('4.18.0'), [
      { channel: 'stable-4.21', graph: forward, classFallback: true, requestedClass: 'eus' },
    ]);
    expect(options.find((o) => o.version === v('4.21.5'))?.via?.classFallback).toBe(true);
  });

  it('carries the reachable frontier across chained look-ahead channels', () => {
    const anchor = buildGraph(['4.18.0', '4.20.0'], [[0, 1]]);
    const seg1 = buildGraph(['4.20.0', '4.21.0'], [[0, 1]]);
    const seg2 = buildGraph(['4.21.0', '4.22.9'], [[0, 1]]);
    const options = buildTargetOptions(anchor, v('4.18.0'), [
      { channel: 'eus-4.21', graph: seg1, classFallback: false },
      { channel: 'eus-4.22', graph: seg2, classFallback: false },
    ]);
    expect(options.find((o) => o.version === v('4.22.9'))?.reachable).toBe(true);
  });

  it('joins a later look-ahead channel directly to the anchor when an earlier one is a sibling stream, not a link', () => {
    // 4.23 and 5.0 both follow 4.22; 5.0 must not have to pass through 4.23.
    const anchor = buildGraph(['4.22.0', '4.22.1', '4.22.5'], [[0, 1], [0, 2]]);
    const seg423 = buildGraph(['4.22.1', '4.23.0-ec.0'], [[0, 1]]);
    const seg50 = buildGraph(['4.22.5', '5.0.0-rc.1'], [[0, 1]]);
    const options = buildTargetOptions(anchor, v('4.22.0'), [
      { channel: 'candidate-4.23', graph: seg423, classFallback: true, requestedClass: 'stable' },
      { channel: 'candidate-5.0', graph: seg50, classFallback: true, requestedClass: 'stable' },
    ]);
    expect(options.find((o) => o.version === v('5.0.0-rc.1'))?.reachable).toBe(true);
  });
});
