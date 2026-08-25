import { describe, expect, it } from 'vitest';
import type { Path } from '../../engine/types';
import type { GraphNode, Version } from '../../graph/types';
import { buildHopCommands, buildScript, type ChannelContext } from '../commands';

function node(version: string, payload: string, channels: readonly number[] = []): GraphNode {
  return { version: version as Version, payload, channels };
}

// Mirrors the verified worked example from plan.md §1/§6: 4.18.2 -> 4.18.50
// -> 4.19.40 -> 4.20.32, every version on the path a real member of both
// `stable-4.20` and `eus-4.20` (plan.md §6 "Command output, for the
// verified example" table).
const PATH: Path = {
  versions: ['4.18.2', '4.18.50', '4.19.40', '4.20.32'] as unknown as readonly Version[],
  hops: [
    { from: '4.18.2' as Version, to: '4.18.50' as Version, risks: [] },
    { from: '4.18.50' as Version, to: '4.19.40' as Version, risks: [] },
    { from: '4.19.40' as Version, to: '4.20.32' as Version, risks: [] },
  ],
  cost: { hops: 3, riskWeight: 0, tieBreak: -122 },
  riskSummary: [],
};

// channelNames[0] = stable-4.20, channelNames[1] = eus-4.20 -- every hop
// target is a member of both (indices [0, 1]), matching the verified table.
const CHANNEL_NAMES = ['stable-4.20', 'eus-4.20'];

const NODE_INFO = new Map<Version, GraphNode>([
  ['4.18.50' as Version, node('4.18.50', 'quay.io/openshift-release-dev/ocp-release@sha256:aaa', [0, 1])],
  ['4.19.40' as Version, node('4.19.40', 'quay.io/openshift-release-dev/ocp-release@sha256:bbb', [0, 1])],
  ['4.20.32' as Version, node('4.20.32', 'quay.io/openshift-release-dev/ocp-release@sha256:ccc', [0, 1])],
]);

const SINGLE_GRAPH: ChannelContext = { channelNames: CHANNEL_NAMES, multiGraph: false };

describe('buildHopCommands', () => {
  it('emits zero channel-switch commands for the verified single-channel path (plan.md §6)', () => {
    const commands = buildHopCommands(PATH, 'stable-4.20', NODE_INFO, SINGLE_GRAPH);
    expect(commands).toHaveLength(3);
    expect(commands.every((c) => c.channelSwitch === undefined)).toBe(true);
    expect(commands.every((c) => c.channelSwitchTo === undefined)).toBe(true);
  });

  it('never names an odd-minor EUS channel for an eus-4.20 selection over the same path', () => {
    const commands = buildHopCommands(PATH, 'eus-4.20', NODE_INFO, SINGLE_GRAPH);
    expect(commands.every((c) => c.channelSwitch === undefined)).toBe(true);
    // Defect 1(a): eus-4.19 does not exist (EUS channels are even-minor
    // only) and must never appear anywhere in the emitted output.
    const script = buildScript(commands);
    expect(script).not.toContain('eus-4.19');
    expect(commands.map((c) => c.channelSwitch).join('')).not.toContain('eus-4.19');
  });

  it('emits a real, genuinely-required switch, preferring the current channel class', () => {
    // 4.19.5 -> 4.19.9 stays on stable-4.19; 4.19.9 -> 4.20.1 leaves it (4.20.1
    // is only published on fast/candidate-4.20); 4.20.1 -> 4.20.9 stays on
    // whatever the previous hop actually switched to.
    const path: Path = {
      versions: ['4.19.5', '4.19.9', '4.20.1', '4.20.9'] as unknown as readonly Version[],
      hops: [
        { from: '4.19.5' as Version, to: '4.19.9' as Version, risks: [] },
        { from: '4.19.9' as Version, to: '4.20.1' as Version, risks: [] },
        { from: '4.20.1' as Version, to: '4.20.9' as Version, risks: [] },
      ],
      cost: { hops: 3, riskWeight: 0, tieBreak: 0 },
      riskSummary: [],
    };
    const channelNames = ['stable-4.19', 'stable-4.20', 'fast-4.20', 'candidate-4.20'];
    const nodeInfo = new Map<Version, GraphNode>([
      ['4.19.9' as Version, node('4.19.9', 'sha:1', [0])], // stable-4.19 only
      ['4.20.1' as Version, node('4.20.1', 'sha:2', [2, 3])], // fast-4.20, candidate-4.20 -- no stable-4.20
      ['4.20.9' as Version, node('4.20.9', 'sha:3', [2])], // fast-4.20 only
    ]);

    const commands = buildHopCommands(path, 'stable-4.19', nodeInfo, { channelNames, multiGraph: false });

    expect(commands[0]?.channelSwitch).toBeUndefined(); // 4.19.9 still on stable-4.19
    expect(commands[1]?.channelSwitchTo).toBe('fast-4.20'); // no stable-4.20 member -> falls back to first real member
    expect(commands[1]?.channelSwitch).toBe('oc adm upgrade channel fast-4.20');
    expect(commands[2]?.channelSwitch).toBeUndefined(); // already on fast-4.20 from the previous switch
  });

  it('prefers a same-class channel over other real members when one exists', () => {
    const path: Path = {
      versions: ['4.19.5', '4.20.1'] as unknown as readonly Version[],
      hops: [{ from: '4.19.5' as Version, to: '4.20.1' as Version, risks: [] }],
      cost: { hops: 1, riskWeight: 0, tieBreak: 0 },
      riskSummary: [],
    };
    const channelNames = ['candidate-4.20', 'stable-4.20'];
    const nodeInfo = new Map<Version, GraphNode>([['4.20.1' as Version, node('4.20.1', 'sha:1', [0, 1])]]);

    const commands = buildHopCommands(path, 'stable-4.19', nodeInfo, { channelNames, multiGraph: false });
    expect(commands[0]?.channelSwitchTo).toBe('stable-4.20');
  });

  it('emits the plain --to command for every hop', () => {
    const commands = buildHopCommands(PATH, 'stable-4.20', NODE_INFO, SINGLE_GRAPH);
    expect(commands.map((c) => c.upgradeTo)).toEqual([
      'oc adm upgrade --to 4.18.50',
      'oc adm upgrade --to 4.19.40',
      'oc adm upgrade --to 4.20.32',
    ]);
  });

  it('emits the digest form from nodeInfo when available', () => {
    const commands = buildHopCommands(PATH, 'stable-4.20', NODE_INFO, SINGLE_GRAPH);
    expect(commands[0]?.upgradeToImage).toBe(
      'oc adm upgrade --to-image=quay.io/openshift-release-dev/ocp-release@sha256:aaa --allow-explicit-upgrade',
    );
  });

  it('omits the digest line when nodeInfo has no entry for the hop target', () => {
    const commands = buildHopCommands(PATH, 'stable-4.20', new Map(), SINGLE_GRAPH);
    expect(commands.every((c) => c.upgradeToImage === undefined)).toBe(true);
  });

  it('omits channel switches entirely when no channel is known', () => {
    const commands = buildHopCommands(PATH, undefined, NODE_INFO, SINGLE_GRAPH);
    expect(commands.every((c) => c.channelSwitch === undefined)).toBe(true);
  });

  // Superseded: this used to assert that a multi-graph stitch NEVER emits a
  // switch, because `Path`/`PathHop` carried no per-segment attribution at
  // all -- see plan.md §6 "Look-ahead targets (bidirectional stitching)".
  // Now that the stitcher tags every hop with `sourceChannel`
  // (engine/types.ts), a genuine multi-graph result *can* and must emit a
  // correctly-attributed switch; a `multiGraph: true` context with NO
  // per-hop provenance (the old, hand-built-`Path` shape below) still falls
  // back to "no switch", since the membership fallback path is deliberately
  // skipped for multi-graph (design/commands.ts doc) -- that part of the old
  // assumption still holds and is re-asserted here under its new name.
  it('the membership fallback still emits no switch for a multi-graph context when hops carry no sourceChannel', () => {
    const commands = buildHopCommands(PATH, 'stable-4.20', NODE_INFO, { channelNames: CHANNEL_NAMES, multiGraph: true });
    expect(commands.every((c) => c.channelSwitch === undefined)).toBe(true);
    expect(commands.every((c) => c.channelSwitchTo === undefined)).toBe(true);
  });

  it('a real multi-graph stitch (hops carrying sourceChannel) emits a switch at exactly the hop that crosses the segment boundary', () => {
    const path: Path = {
      versions: ['4.18.0', '4.19.0', '4.20.0', '4.21.0'] as unknown as readonly Version[],
      hops: [
        { from: '4.18.0' as Version, to: '4.19.0' as Version, risks: [], sourceChannel: 'eus-4.20' },
        { from: '4.19.0' as Version, to: '4.20.0' as Version, risks: [], sourceChannel: 'eus-4.20' },
        { from: '4.20.0' as Version, to: '4.21.0' as Version, risks: [], sourceChannel: 'eus-4.22' },
      ],
      cost: { hops: 3, riskWeight: 0, tieBreak: 0 },
      riskSummary: [],
    };
    const commands = buildHopCommands(path, 'eus-4.20', new Map(), { channelNames: [], multiGraph: true });

    expect(commands[0]?.channelSwitch).toBeUndefined();
    expect(commands[1]?.channelSwitch).toBeUndefined();
    expect(commands[2]?.channelSwitchTo).toBe('eus-4.22'); // the real, already-fetched channel -- never fabricated
    expect(commands[2]?.channelSwitch).toBe('oc adm upgrade channel eus-4.22');
  });

  it('a multi-graph stitch that never actually leaves the anchor channel (both segments produced hops on the same channel) emits no switch', () => {
    const path: Path = {
      versions: ['4.18.0', '4.19.0'] as unknown as readonly Version[],
      hops: [{ from: '4.18.0' as Version, to: '4.19.0' as Version, risks: [], sourceChannel: 'eus-4.20' }],
      cost: { hops: 1, riskWeight: 0, tieBreak: 0 },
      riskSummary: [],
    };
    const commands = buildHopCommands(path, 'eus-4.20', new Map(), { channelNames: [], multiGraph: true });
    expect(commands[0]?.channelSwitch).toBeUndefined();
  });

  it('provenance-based switching tracks the channel hop by hop, judging a later hop against wherever the previous switch actually left the cluster', () => {
    const path: Path = {
      versions: ['4.20.0', '4.21.0', '4.22.0'] as unknown as readonly Version[],
      hops: [
        { from: '4.20.0' as Version, to: '4.21.0' as Version, risks: [], sourceChannel: 'stable-4.21' },
        { from: '4.21.0' as Version, to: '4.22.0' as Version, risks: [], sourceChannel: 'eus-4.22' },
      ],
      cost: { hops: 2, riskWeight: 0, tieBreak: 0 },
      riskSummary: [],
    };
    const commands = buildHopCommands(path, 'eus-4.20', new Map(), { channelNames: [], multiGraph: true });
    expect(commands[0]?.channelSwitchTo).toBe('stable-4.21'); // the eus -> stable fallback drop
    expect(commands[1]?.channelSwitchTo).toBe('eus-4.22'); // judged against stable-4.21, not the original eus-4.20 selection
  });
});

describe('buildScript', () => {
  it('joins commands into a script with no switch lines for the verified single-channel path', () => {
    const commands = buildHopCommands(PATH, 'stable-4.20', NODE_INFO, SINGLE_GRAPH);
    expect(buildScript(commands)).toBe(
      ['oc adm upgrade --to 4.18.50', 'oc adm upgrade --to 4.19.40', 'oc adm upgrade --to 4.20.32'].join('\n'),
    );
  });

  it('comments a genuine switch line with why it is there', () => {
    const path: Path = {
      versions: ['4.19.5', '4.20.1'] as unknown as readonly Version[],
      hops: [{ from: '4.19.5' as Version, to: '4.20.1' as Version, risks: [] }],
      cost: { hops: 1, riskWeight: 0, tieBreak: 0 },
      riskSummary: [],
    };
    const channelNames = ['fast-4.20'];
    const nodeInfo = new Map<Version, GraphNode>([['4.20.1' as Version, node('4.20.1', 'sha:1', [0])]]);
    const commands = buildHopCommands(path, 'stable-4.19', nodeInfo, { channelNames, multiGraph: false });

    expect(buildScript(commands)).toBe(
      ['oc adm upgrade channel fast-4.20  # destination isn\'t on the current channel', 'oc adm upgrade --to 4.20.1'].join('\n'),
    );
  });
});
