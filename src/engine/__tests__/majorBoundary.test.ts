import { describe, expect, it } from 'vitest';
import { buildHopCommands } from '../../design/commands';
import { parseRawGraph } from '../../graph/parse';
import type { Graph, Version } from '../../graph/types';
import { err, ok } from '../../lib/result';
import { describeStitchError } from '../../planner/describeStitchError';
import { loadFixture } from '../../test-utils/fixtures';
import { stitchAndFindPath } from '../stitch';
import type { GraphLoader } from '../types';
import { streamOf } from '../version';

// Live Cincinnati, captured 2026-11-01: stable-5.0 and fast-5.0 are empty,
// candidate-5.0 carries 4.22.z upgrade sources plus 5.0.0-ec/rc and 5.0.0.
const FIXTURE_CHANNELS = ['stable-4.21', 'stable-4.22', 'candidate-5.0'] as const;

function v(s: string): Version {
  return s as Version;
}

function fixtureGraph(channel: string): Graph {
  const result = parseRawGraph(loadFixture(`${channel}.json`), { channel, arch: 'amd64' });
  if (!result.ok) throw new Error(`fixture ${channel}: ${JSON.stringify(result.error)}`);
  return result.value;
}

const graphs = new Map<string, Graph>(FIXTURE_CHANNELS.map((c) => [c, fixtureGraph(c)]));

function fixtureLoader(calls: string[] = []): GraphLoader {
  return async (channel, arch) => {
    calls.push(channel);
    const graph = graphs.get(channel);
    return graph ? ok(graph) : err({ kind: 'empty', channel, arch });
  };
}

function hasEdge(graph: Graph, from: Version, to: Version): boolean {
  const fromIdx = graph.nodes.findIndex((n) => n.version === from);
  const toIdx = graph.nodes.findIndex((n) => n.version === to);
  return (
    graph.edges.some(([a, b]) => a === fromIdx && b === toIdx) ||
    graph.conditionalEdges.some((group) => group.edges.some((e) => e.from === from && e.to === to))
  );
}

describe('stitching across the 4.22 -> 5.0 major boundary (live fixtures)', () => {
  it('reaches 5.0.0-rc.8 from 4.21.0 on stable-4.22 through 4.22.z, via candidate-5.0', async () => {
    const result = await stitchAndFindPath(fixtureLoader(), {
      targetChannel: 'stable-4.22',
      arch: 'amd64',
      start: v('4.21.0'),
      target: v('5.0.0-rc.8'),
    });
    if (!result.ok) throw new Error(describeStitchError(result.error));
    const { primary, stitch } = result.value;

    expect(stitch.channelsUsed).toEqual(['stable-4.22', 'candidate-5.0']);
    expect(stitch.classFallbacks).toEqual([{ channel: 'candidate-5.0', requestedClass: 'stable' }]);
    expect(primary.versions[0]).toBe('4.21.0');
    expect(primary.versions.at(-1)).toBe('5.0.0-rc.8');
    expect(primary.versions.some((ver) => streamOf(ver).major === 4 && streamOf(ver).minor === 22)).toBe(true);
    for (const hop of primary.hops) {
      const source = graphs.get(hop.sourceChannel as string) as Graph;
      expect(hasEdge(source, hop.from, hop.to), `${hop.from} -> ${hop.to} in ${hop.sourceChannel}`).toBe(true);
    }
  });

  it('emits one switch to candidate-5.0, at the first station candidate-5.0 lists', async () => {
    const result = await stitchAndFindPath(fixtureLoader(), {
      targetChannel: 'stable-4.22',
      arch: 'amd64',
      start: v('4.21.0'),
      target: v('5.0.0-rc.8'),
    });
    if (!result.ok) throw new Error(describeStitchError(result.error));
    const { primary, nodeInfo } = result.value;

    const commands = buildHopCommands(primary, 'stable-4.22', nodeInfo, { channelNames: [], multiGraph: true });
    const switches = commands.filter((c) => c.channelSwitchTo);
    const candidate50 = new Set(graphs.get('candidate-5.0')?.nodes.map((n) => n.version));
    const firstMember = primary.versions.find((ver) => candidate50.has(ver));

    expect(switches.map((c) => c.channelSwitch)).toEqual(['oc adm upgrade channel candidate-5.0']);
    expect(switches[0]?.from).toBe(firstMember);
  });

  it('steps back from candidate-5.0 to the 4.22 stream its own upgrade sources name, not to "5.-1"', async () => {
    const calls: string[] = [];
    const result = await stitchAndFindPath(fixtureLoader(calls), {
      targetChannel: 'stable-4.21',
      arch: 'amd64',
      start: v('4.20.0'),
      target: v('5.0.0-rc.8'),
    });
    if (!result.ok) throw new Error(describeStitchError(result.error));

    expect(result.value.stitch.channelsUsed).toEqual(['stable-4.21', 'candidate-5.0', 'stable-4.22']);
    expect(calls).toEqual(['stable-4.21', 'stable-5.0', 'fast-5.0', 'candidate-5.0', 'stable-4.22']);
    expect(result.value.primary.versions.at(-1)).toBe('5.0.0-rc.8');
  });

  it('plans within candidate-5.0 when it is the anchor', async () => {
    const result = await stitchAndFindPath(fixtureLoader(), {
      targetChannel: 'candidate-5.0',
      arch: 'amd64',
      start: v('4.22.3'),
      target: v('5.0.0-rc.8'),
    });
    if (!result.ok) throw new Error(describeStitchError(result.error));
    expect(result.value.stitch).toEqual({ channelsUsed: ['candidate-5.0'], classFallbacks: [], multiGraph: false });
  });

  it('reports an empty stable-5.0 anchor as a named, empty channel instead of crashing', async () => {
    const result = await stitchAndFindPath(fixtureLoader(), {
      targetChannel: 'stable-5.0',
      arch: 'amd64',
      start: v('4.22.3'),
      target: v('5.0.0-rc.8'),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({ kind: 'loadFailed', channel: 'stable-5.0', error: { kind: 'empty' } });
    expect(describeStitchError(result.error)).toContain('candidate-5.0');
  });
});
