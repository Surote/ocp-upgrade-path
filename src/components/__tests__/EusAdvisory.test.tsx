import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { PathHop } from '../../engine/types';
import type { Version } from '../../graph/types';
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
