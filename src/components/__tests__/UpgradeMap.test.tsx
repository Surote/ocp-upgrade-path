import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { HopCommand } from '../../design/commands';
import type { Path } from '../../engine/types';
import type { GraphNode, Version } from '../../graph/types';
import { UpgradeMap } from '../UpgradeMap';

function v(s: string): Version {
  return s as Version;
}

// Mirrors the exact defect report and plan.md §6's worked example:
// eus-4.20 -> 4.22.9, switch belongs on 4.20.33 (the earliest station on
// the path already a member of eus-4.22), not on 4.21.28.
const PATH: Path = {
  versions: [v('4.18.2'), v('4.18.51'), v('4.19.41'), v('4.20.33'), v('4.21.28'), v('4.22.9')],
  hops: [
    { from: v('4.18.2'), to: v('4.18.51'), risks: [], sourceChannel: 'eus-4.20' },
    { from: v('4.18.51'), to: v('4.19.41'), risks: [], sourceChannel: 'eus-4.20' },
    { from: v('4.19.41'), to: v('4.20.33'), risks: [], sourceChannel: 'eus-4.20' },
    { from: v('4.20.33'), to: v('4.21.28'), risks: [], sourceChannel: 'eus-4.22' },
    { from: v('4.21.28'), to: v('4.22.9'), risks: [], sourceChannel: 'eus-4.22' },
  ],
  cost: { hops: 5, riskWeight: 0, tieBreak: 0 },
  riskSummary: [],
};

// The commands a correctly-fixed `buildHopCommands` produces for `PATH`:
// exactly one switch, carried on the hop *departing* 4.20.33.
const COMMANDS: readonly HopCommand[] = [
  { from: v('4.18.2'), to: v('4.18.51'), upgradeTo: 'oc adm upgrade --to 4.18.51' },
  { from: v('4.18.51'), to: v('4.19.41'), upgradeTo: 'oc adm upgrade --to 4.19.41' },
  { from: v('4.19.41'), to: v('4.20.33'), upgradeTo: 'oc adm upgrade --to 4.20.33' },
  {
    from: v('4.20.33'),
    to: v('4.21.28'),
    channelSwitch: 'oc adm upgrade channel eus-4.22',
    channelSwitchTo: 'eus-4.22',
    upgradeTo: 'oc adm upgrade --to 4.21.28',
  },
  { from: v('4.21.28'), to: v('4.22.9'), upgradeTo: 'oc adm upgrade --to 4.22.9' },
];

const EMPTY_NODE_INFO = new Map<Version, GraphNode>();

function noop() {
  /* not exercised by these assertions */
}

describe('UpgradeMap — interchange ring placement (plan.md §6 "Where the switch is attributed matters")', () => {
  afterEach(cleanup);

  it('places the interchange ring/label on 4.20.33 (the earliest member station), not on 4.21.28', () => {
    render(
      <UpgradeMap
        path={PATH}
        nodeInfo={EMPTY_NODE_INFO}
        commands={COMMANDS}
        selectedHopIndex={null}
        selectedStationIndex={null}
        onSelectHop={noop}
        onSelectStation={noop}
      />,
    );

    const station420 = screen.getByRole('button', { name: /^Station 4\.20\.33,/ });
    expect(station420).toHaveAccessibleName(/interchange — switch to channel eus-4\.22/);

    const station421 = screen.getByRole('button', { name: /^Station 4\.21\.28,/ });
    expect(station421).not.toHaveAccessibleName(/interchange/);

    // Every other station is also switch-free.
    for (const version of ['4.18.2', '4.18.51', '4.19.41', '4.22.9']) {
      const station = screen.getByRole('button', { name: new RegExp(`^Station ${version.replace(/\./g, '\\.')},`) });
      expect(station).not.toHaveAccessibleName(/interchange/);
    }

    // The inline tag text renders once, on the correct station only.
    expect(screen.getByText('⇄ switch to eus-4.22')).toBeInTheDocument();
  });

  it('emits no interchange ring at all when no command carries a channelSwitch (the stable-4.20 regression)', () => {
    const path: Path = {
      versions: [v('4.18.2'), v('4.18.50'), v('4.19.40'), v('4.20.32')],
      hops: [
        { from: v('4.18.2'), to: v('4.18.50'), risks: [] },
        { from: v('4.18.50'), to: v('4.19.40'), risks: [] },
        { from: v('4.19.40'), to: v('4.20.32'), risks: [] },
      ],
      cost: { hops: 3, riskWeight: 0, tieBreak: 0 },
      riskSummary: [],
    };
    const commands: readonly HopCommand[] = [
      { from: v('4.18.2'), to: v('4.18.50'), upgradeTo: 'oc adm upgrade --to 4.18.50' },
      { from: v('4.18.50'), to: v('4.19.40'), upgradeTo: 'oc adm upgrade --to 4.19.40' },
      { from: v('4.19.40'), to: v('4.20.32'), upgradeTo: 'oc adm upgrade --to 4.20.32' },
    ];

    render(
      <UpgradeMap
        path={path}
        nodeInfo={EMPTY_NODE_INFO}
        commands={commands}
        selectedHopIndex={null}
        selectedStationIndex={null}
        onSelectHop={noop}
        onSelectStation={noop}
      />,
    );

    expect(screen.queryByText(/⇄ switch to/)).not.toBeInTheDocument();
    expect(screen.queryByText('⇄ ring = channel switch required')).not.toBeInTheDocument();
    for (const version of ['4.18.2', '4.18.50', '4.19.40', '4.20.32']) {
      const station = screen.getByRole('button', { name: new RegExp(`^Station ${version.replace(/\./g, '\\.')},`) });
      expect(station).not.toHaveAccessibleName(/interchange/);
    }
  });
});
