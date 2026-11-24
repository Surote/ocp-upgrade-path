import { cleanup, render, screen, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import type { HopCommand } from '../../design/commands';
import { NO_MARKS } from '../../engine/risks';
import type { Path } from '../../engine/types';
import type { Version } from '../../graph/types';
import { AlternatesPanel } from '../AlternatesPanel';
import { LowerRiskRoute } from '../LowerRiskRoute';
import { RouteSummary } from '../RouteSummary';
import { UpgradeMap } from '../UpgradeMap';

afterEach(cleanup);

const v = (s: string) => s as Version;

function path(...versions: string[]): Path {
  const hops = versions.slice(1).map((to, i) => ({ from: v(versions[i] as string), to: v(to), risks: [] }));
  return { versions: versions.map(v), hops, cost: { hops: hops.length, riskWeight: 0, tieBreak: 0 }, riskSummary: [] };
}

function commands(p: Path): readonly HopCommand[] {
  return p.hops.map((h) => ({ from: h.from, to: h.to, upgradeTo: `oc adm upgrade --to ${h.to}` }));
}

// A pinned stop can route through one release twice; the reroute visits it once.
const REVISIT = path('4.20.10', '4.21.5', '4.20.12', '4.21.5', '4.22.1');
const REROUTE = path('4.20.10', '4.20.11', '4.21.5', '4.22.1');

function items(list: HTMLElement): string[] {
  return within(list).getAllByRole('listitem').map((li) => li.textContent ?? '');
}

function rerouted(view: (p: Path) => ReactElement): void {
  const { rerender } = render(view(REVISIT));
  rerender(view(REROUTE));
}

describe('route lists render one entry per visit', () => {
  it('drops the second visit from the route summary after a reroute', () => {
    rerouted((p) => <RouteSummary path={p} notApplicable={NO_MARKS} />);
    expect(items(screen.getByRole('list', { name: 'Upgrade path stops' }))).toEqual(['4.20.10', '4.20.11', '4.21.5', '4.22.1']);
  });

  it('drops the second station from the map after a reroute', () => {
    rerouted((p) => (
      <UpgradeMap
        path={p}
        stations={[]}
        commands={commands(p)}
        selectedHopIndex={null}
        selectedStationIndex={null}
        onSelectHop={() => {}}
        onSelectStation={() => {}}
      />
    ));
    const stations = screen.getAllByRole('button', { name: /^Station / }).map((s) => s.getAttribute('aria-label')?.split(',')[0]);
    expect(stations).toEqual(['Station 4.20.10', 'Station 4.20.11', 'Station 4.21.5', 'Station 4.22.1']);
  });

  it('drops the second visit from the lower-risk route after a reroute', () => {
    rerouted((p) => (
      <LowerRiskRoute primary={REVISIT} comparison={{ route: p, conditionalFree: true }} notApplicable={NO_MARKS} onUse={() => {}} />
    ));
    const section = screen.getByRole('region', { name: 'Lower-risk route' });
    expect(items(within(section).getByRole('list'))).toEqual(['4.20.10', '4.20.11', '4.21.5', '4.22.1']);
  });

  it('drops the second visit from an alternate after a reroute', () => {
    rerouted((p) => <AlternatesPanel alternates={{ kind: 'computed', paths: [p] }} channelsUsed={[]} />);
    const alternate = screen.getByText(/^Alternate 1/).closest('li') as HTMLElement;
    expect(items(within(alternate).getByRole('list'))).toEqual(['4.20.10', '4.20.11', '4.21.5', '4.22.1']);
  });
});
