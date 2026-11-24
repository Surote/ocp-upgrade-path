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

interface RawConditionalEdges {
  readonly edges: readonly { readonly from: string; readonly to: string }[];
  readonly risks: readonly { readonly url: string; readonly name: string; readonly message: string; readonly matchingRules: readonly { readonly type: 'Always' }[] }[];
}

/** `channels` is the membership every node advertises; forward discovery follows it. */
function rawGraph(
  nodeVersions: readonly string[],
  edges: ReadonlyArray<readonly [number, number]>,
  payloadTag: string,
  channels: readonly string[] = [],
  conditionalEdges: readonly RawConditionalEdges[] = [],
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
    conditionalEdges,
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
    const eus420 = rawGraph(['4.18.2', '4.18.51', '4.19.41', '4.20.33'], [[0, 1], [1, 2], [2, 3]], 'EUS420', ['eus-4.20', 'eus-4.22']);
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

  it('never switches early onto a channel that does not publish the hops moved onto it', async () => {
    // stable-4.22 lists 4.20.1 and 4.21.1 but publishes only 4.21.1 -> 4.22.1,
    // so 4.20.1 -> 4.21.1 has to be taken on stable-4.21 first.
    const stable420 = rawGraph(['4.19.9', '4.20.1'], [[0, 1]], 'S420', ['stable-4.20', 'stable-4.21', 'stable-4.22']);
    const stable421 = rawGraph(['4.20.1', '4.21.1'], [[0, 1]], 'S421', ['stable-4.21', 'stable-4.22']);
    const stable422 = rawGraph(['4.20.1', '4.21.1', '4.22.1'], [[1, 2]], 'S422', ['stable-4.22']);
    const graphs = new Map([
      ['stable-4.20', stable420],
      ['stable-4.21', stable421],
      ['stable-4.22', stable422],
    ]);
    const loader: GraphLoader = async (channel) => {
      const graph = graphs.get(channel);
      return graph ? ok(graph) : err({ kind: 'empty', channel, arch: 'amd64' });
    };

    const stitched = await stitchAndFindPath(loader, {
      targetChannel: 'stable-4.20',
      arch: 'amd64',
      start: v('4.20.1'),
      target: v('4.22.1'),
    });
    expect(stitched.ok).toBe(true);
    if (!stitched.ok) return;

    const commands = buildHopCommands(stitched.value.primary, 'stable-4.20', stitched.value.nodeInfo, {
      channelNames: [],
      multiGraph: stitched.value.stitch.multiGraph,
    });
    expect(buildScript(commands).split('\n')).toEqual([
      'oc adm upgrade channel stable-4.21  # destination isn\'t on the current channel',
      'oc adm upgrade --to 4.21.1',
      'oc adm upgrade channel stable-4.22  # destination isn\'t on the current channel',
      'oc adm upgrade --to 4.22.1',
    ]);
  });

  it('shows each hop with exactly the risks the channel in effect attaches to that edge', async () => {
    // stable-4.21 publishes 4.20.0 -> 4.21.0 unconditionally; eus-4.22 publishes
    // the same edge only as a conditional update with an Always risk.
    const alwaysRisk = { url: 'https://issues.redhat.com/browse/OCPBUGS-1', name: 'EusOnlyRisk', message: 'Breaks every cluster.', matchingRules: [{ type: 'Always' as const }] };
    const graphs = new Map([
      ['eus-4.20', rawGraph(['4.19.0', '4.20.0'], [[0, 1]], 'E420', ['eus-4.20', 'stable-4.21', 'eus-4.22'])],
      ['stable-4.21', rawGraph(['4.20.0', '4.21.0'], [[0, 1]], 'S421')],
      [
        'eus-4.22',
        rawGraph(['4.20.0', '4.21.0', '4.22.0'], [[1, 2]], 'E422', [], [{ edges: [{ from: '4.20.0', to: '4.21.0' }], risks: [alwaysRisk] }]),
      ],
    ]);
    const loader: GraphLoader = async (channel) => {
      const graph = graphs.get(channel);
      return graph ? ok(graph) : err({ kind: 'empty', channel, arch: 'amd64' });
    };

    const stitched = await stitchAndFindPath(loader, { targetChannel: 'eus-4.20', arch: 'amd64', start: v('4.19.0'), target: v('4.22.0') });
    expect(stitched.ok).toBe(true);
    if (!stitched.ok) return;
    const { primary } = stitched.value;
    const commands = buildHopCommands(primary, 'eus-4.20', stitched.value.nodeInfo, { channelNames: [], multiGraph: true });

    let channel = 'eus-4.20';
    const shownVsInEffect = commands.map((command, i) => {
      channel = command.channelSwitchTo ?? channel;
      const graph = graphs.get(channel) as Graph;
      const attached = graph.conditionalEdges
        .filter((group) => group.edges.some((e) => e.from === command.from && e.to === command.to))
        .flatMap((group) => group.risks.map((r) => r.name));
      return { hop: `${command.from} -> ${command.to} on ${channel}`, shown: primary.hops[i]?.risks.map((r) => r.name), attached };
    });
    for (const { hop, shown, attached } of shownVsInEffect) expect({ hop, shown }).toEqual({ hop, shown: attached });

    expect(buildScript(commands).split('\n')).toEqual([
      'oc adm upgrade --to 4.20.0',
      'oc adm upgrade channel stable-4.21  # destination isn\'t on the current channel',
      'oc adm upgrade --to 4.21.0',
      'oc adm upgrade channel eus-4.22  # destination isn\'t on the current channel',
      'oc adm upgrade --to 4.22.0',
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
