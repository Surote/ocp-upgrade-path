import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { Version } from '../../graph/types';
import { StitchBanner } from '../StitchBanner';
import { TargetSelect } from '../TargetSelect';

afterEach(cleanup);

describe('marking a plan that relies on a candidate channel', () => {
  it('the result banner says the plan relies on a candidate channel', () => {
    render(
      <StitchBanner
        channelsUsed={['stable-4.22', 'candidate-5.0']}
        classFallbacks={[{ channel: 'candidate-5.0', requestedClass: 'stable' }]}
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent(/relies on a candidate channel/);
  });

  it('an eus -> stable fallback is a class change but not a candidate warning', () => {
    render(<StitchBanner channelsUsed={['eus-4.20', 'stable-4.21']} classFallbacks={[{ channel: 'stable-4.21', requestedClass: 'eus' }]} />);
    expect(screen.getByRole('alert')).toHaveTextContent(/Channel class change/);
    expect(screen.getByRole('alert')).not.toHaveTextContent(/candidate/);
  });

  it('the target dropdown names the channel a look-ahead target needs and flags the class change', () => {
    render(
      <TargetSelect
        id="target"
        model={{
          value: '',
          groups: [
            {
              stream: '5.0',
              options: [{ version: '5.0.0-rc.8' as Version, reachable: true, via: { channel: 'candidate-5.0', classFallback: true } }],
            },
          ],
          lookaheadLoading: false,
          disabled: false,
          onChange: () => {},
        }}
      />,
    );
    expect(screen.getByRole('option', { name: /5\.0\.0-rc\.8/ })).toHaveTextContent('5.0.0-rc.8 · via candidate-5.0 (class change)');
  });
});
