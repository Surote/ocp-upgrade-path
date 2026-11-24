import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { loaderFor } from '../../engine/__tests__/routeFixtures';
import { stitchAndFindPath } from '../../engine/stitch';
import type { PathHop } from '../../engine/types';
import { parseRawGraph } from '../../graph/parse';
import type { Graph, Version } from '../../graph/types';
import { loadFixture } from '../../test-utils/fixtures';
import { EusAdvisory } from '../EusAdvisory';

afterEach(cleanup);

/** A route's hops, each taken from a stable channel's graph. */
function route(...vs: string[]): PathHop[] {
  return vs.slice(1).map((to, i) => ({ from: vs[i] as Version, to: to as Version, risks: [], sourceChannel: 'stable-4.22' }));
}

describe('EusAdvisory', () => {
  it('lists one Control Plane Only leg per EUS-to-EUS span of the route, in order', () => {
    render(<EusAdvisory hops={route('4.16.33', '4.17.59', '4.18.59', '4.19.55', '4.20.46', '4.21.42', '4.22.22', '5.0.1')} />);

    const legs = within(screen.getByRole('list', { name: 'Control Plane Only legs' })).getAllByRole('listitem');
    expect(legs.map((li) => li.querySelector('h3')?.textContent)).toEqual([
      'Leg 1: 4.16 → 4.18 (pause workers before 4.17, unpause at 4.18)',
      'Leg 2: 4.18 → 4.20 (pause workers before 4.19, unpause at 4.20)',
      'Leg 3: 4.20 → 4.22 (pause workers before 4.21, unpause at 4.22)',
    ]);
    expect(within(legs[2] as HTMLElement).getByRole('link').getAttribute('href')).toContain('/openshift_container_platform/4.22/');
    expect(screen.queryByText(/5\.0 →/)).toBeNull();
  });

  it('renders nothing when the route has no complete EUS-to-EUS leg', () => {
    const { container } = render(<EusAdvisory hops={route('4.18.2', '4.19.10')} />);
    expect(container.innerHTML).toBe('');
  });
});

function fixtureGraph(channel: string): Graph {
  const parsed = parseRawGraph(loadFixture(`${channel}.json`), { channel, arch: 'amd64' });
  if (!parsed.ok) throw new Error(`${channel} fixture did not parse`);
  return parsed.value;
}

describe('a leg that crosses a hop from a fast or candidate channel', () => {
  it('says the Control Plane Only update is not available instead of telling the operator to pause (candidate-4.20 fixtures)', async () => {
    const channels = ['candidate-4.20', 'fast-4.19', 'stable-4.19', 'stable-4.20', 'stable-4.21', 'stable-4.22'];
    const loader = loaderFor(Object.fromEntries(channels.map((c) => [c, fixtureGraph(c)])));
    const result = await stitchAndFindPath(loader, {
      targetChannel: 'candidate-4.20',
      arch: 'amd64',
      start: '4.18.42' as Version,
      target: '4.21.40' as Version,
    });
    if (!result.ok) throw new Error(result.error.kind);
    const { primary } = result.value;
    expect(primary.versions).toEqual(['4.18.42', '4.19.43', '4.20.35', '4.21.40']);

    render(<EusAdvisory hops={primary.hops} />);

    const [leg] = within(screen.getByRole('list', { name: 'Control Plane Only legs' })).getAllByRole('listitem') as [HTMLElement];
    expect(leg.querySelector('h3')?.textContent).toBe('Leg 1: 4.18 → 4.20 (Control Plane Only update not available on this route)');
    expect(leg).toHaveTextContent(/the update from 4\.18\.42 to 4\.19\.43 comes from candidate-4\.20/);
    expect(leg).toHaveTextContent(/only after every update involved is available in a stable channel/);
    expect(leg.textContent).not.toMatch(/"paused"|pause workers before/i);
  });

  it('judges each leg on its own hops: a stable leg keeps its pause steps when the next leg crosses a fast hop', () => {
    const stableLeg = route('4.16.33', '4.17.59', '4.18.59');
    const fastLeg = route('4.18.59', '4.19.55', '4.20.46').map((hop, i) => (i === 1 ? { ...hop, sourceChannel: 'fast-4.20' } : hop));
    render(<EusAdvisory hops={[...stableLeg, ...fastLeg]} />);

    const [first, second] = within(screen.getByRole('list', { name: 'Control Plane Only legs' })).getAllByRole('listitem') as [HTMLElement, HTMLElement];
    expect(first).toHaveTextContent(/"paused":true/);
    expect(second.querySelector('h3')?.textContent).toBe('Leg 2: 4.18 → 4.20 (Control Plane Only update not available on this route)');
    expect(second).toHaveTextContent(/the update from 4\.19\.55 to 4\.20\.46 comes from fast-4\.20/);
    expect(second.textContent).not.toMatch(/"paused"/);
  });
});
