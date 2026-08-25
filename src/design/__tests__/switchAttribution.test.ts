import { describe, expect, it } from 'vitest';
import { parseRawGraph } from '../../graph/parse';
import type { Graph, Version } from '../../graph/types';
import { err, ok } from '../../lib/result';
import { stitchAndFindPath } from '../../engine/stitch';
import type { GraphLoader } from '../../engine/types';
import { buildHopCommands, buildScript } from '../commands';

function v(s: string): Version {
  return s as Version;
}

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

// End-to-end regression for the exact defect reported by the user: the
// stitcher (engine/stitch.ts) and the command builder (design/commands.ts)
// combined must attribute a channel switch to the *earliest* station on the
// path that is already a member of the destination channel -- plan.md §6
// "Where the switch is attributed matters" -- and everything downstream
// (the map's ring, HopDetail's copy) reads off `HopCommand.from`/`to`, so
// pinning it here at the command level is what actually guards the UI.
describe('channel-switch attribution — engine + commands, end to end (plan.md §6)', () => {
  it('?channel=eus-4.20&arch=amd64&start=4.18.2&target=4.22.9 attributes the switch to 4.20.33, not 4.21.28', async () => {
    // Mirrors plan.md §6's worked example exactly: eus-4.20 spans 4.18-4.20
    // and does not contain 4.22.9; eus-4.22 spans 4.20-4.22 and shares
    // 4.20.33 with the anchor -- the earliest point the switch is possible.
    const eus420 = rawGraph(['4.18.2', '4.18.51', '4.19.41', '4.20.33'], [[0, 1], [1, 2], [2, 3]], 'EUS420');
    const eus422 = rawGraph(['4.20.33', '4.21.28', '4.22.9'], [[0, 1], [1, 2]], 'EUS422');
    const loader: GraphLoader = async (channel) => {
      if (channel === 'eus-4.20') return ok(eus420);
      if (channel === 'eus-4.22') return ok(eus422);
      return err({ kind: 'empty', channel, arch: 'amd64' });
    };

    const stitched = await stitchAndFindPath(loader, {
      targetChannel: 'eus-4.20',
      arch: 'amd64',
      start: v('4.18.2'),
      target: v('4.22.9'),
    });
    expect(stitched.ok).toBe(true);
    if (!stitched.ok) return;

    expect(stitched.value.primary.versions).toEqual([
      v('4.18.2'),
      v('4.18.51'),
      v('4.19.41'),
      v('4.20.33'),
      v('4.21.28'),
      v('4.22.9'),
    ]);

    const commands = buildHopCommands(stitched.value.primary, 'eus-4.20', stitched.value.nodeInfo, {
      channelNames: [],
      multiGraph: stitched.value.stitch.multiGraph,
    });

    // Exactly one switch, and it's carried on the hop *departing* 4.20.33
    // (4.20.33 -> 4.21.28) -- never on the hop that arrives at 4.21.28's
    // successor, and never on the 4.19.41 -> 4.20.33 hop either (that would
    // be the pre-fix off-by-one in the other direction).
    const switching = commands.filter((c) => c.channelSwitch);
    expect(switching).toHaveLength(1);
    expect(switching[0]?.from).toBe('4.20.33');
    expect(switching[0]?.to).toBe('4.21.28');
    expect(switching[0]?.channelSwitchTo).toBe('eus-4.22');
    expect(switching[0]?.channelSwitch).toBe('oc adm upgrade channel eus-4.22');

    // The script keeps the switch line positioned between the two --to
    // lines it belongs between: reached 4.20.33, switch, continue to
    // 4.21.28. This ordering is already correct and unaffected by the fix
    // -- only *which station the ring/label point at* was wrong before.
    expect(buildScript(commands).split('\n')).toEqual([
      'oc adm upgrade --to 4.18.51',
      'oc adm upgrade --to 4.19.41',
      'oc adm upgrade --to 4.20.33',
      'oc adm upgrade channel eus-4.22  # destination isn\'t on the current channel',
      'oc adm upgrade --to 4.21.28',
      'oc adm upgrade --to 4.22.9',
    ]);
  });

  it('?channel=stable-4.20&arch=amd64&start=4.18.2&target=4.20.32 regression: zero switch commands, 3 hops', async () => {
    const stable420 = rawGraph(['4.18.2', '4.18.50', '4.19.40', '4.20.32'], [[0, 1], [1, 2], [2, 3]], 'STABLE420');
    const loader: GraphLoader = async (channel) => {
      if (channel === 'stable-4.20') return ok(stable420);
      return err({ kind: 'empty', channel, arch: 'amd64' });
    };

    const stitched = await stitchAndFindPath(loader, {
      targetChannel: 'stable-4.20',
      arch: 'amd64',
      start: v('4.18.2'),
      target: v('4.20.32'),
    });
    expect(stitched.ok).toBe(true);
    if (!stitched.ok) return;
    expect(stitched.value.stitch.multiGraph).toBe(false);
    expect(stitched.value.primary.hops).toHaveLength(3);

    const commands = buildHopCommands(stitched.value.primary, 'stable-4.20', stitched.value.nodeInfo, {
      channelNames: [],
      multiGraph: false,
    });
    expect(commands).toHaveLength(3);
    expect(commands.every((c) => c.channelSwitch === undefined)).toBe(true);
  });
});
