import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { Version } from '../../graph/types';
import type { RouteConstraintsViewModel } from '../../planner/usePlanner';
import { RouteConstraints } from '../RouteConstraints';

afterEach(cleanup);

const noop = () => {};

function model(options: { version: string; channel: string }[]): RouteConstraintsViewModel {
  return {
    stops: [
      {
        value: '',
        groups: [{ stream: '4.20', options: options.map((o) => ({ version: o.version as Version, channel: o.channel })) }],
        onChange: noop,
        onRemove: noop,
      },
    ],
    canAddStop: true,
    onAddStop: noop,
    riskPolicy: 'recommended',
    onRiskPolicyChange: noop,
  };
}

describe('stop options', () => {
  // The option's channel is where some route can arrive, not necessarily the planned one,
  // so the label must not read as the route's channel the way the target's "via" does.
  it('names a channel other than the selected one as where the stop is reachable, not as the route', () => {
    render(<RouteConstraints model={model([{ version: '4.20.5', channel: 'eus-4.20' }])} selectedChannel="eus-4.18" />);
    const option = screen.getByRole('option', { name: /4\.20\.5/ });
    expect(option.textContent).toBe('4.20.5 · reachable on eus-4.20');
  });

  it('shows only the version when the selected channel can deliver the stop', () => {
    render(<RouteConstraints model={model([{ version: '4.18.50', channel: 'eus-4.18' }])} selectedChannel="eus-4.18" />);
    expect(screen.getByRole('option', { name: /4\.18\.50/ }).textContent).toBe('4.18.50');
  });
});
