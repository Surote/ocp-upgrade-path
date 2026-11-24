import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { graph, loaderFor, v } from '../../engine/__tests__/routeFixtures';
import { stitchAndFindPath } from '../../engine/stitch';
import { PathResult } from '../PathResult';

afterEach(cleanup);

describe('stitch banner', () => {
  it('names every channel change in route order, including a return to a channel used earlier', async () => {
    const loader = loaderFor({
      'stable-4.22': graph([], { nodes: ['4.22.20'], channels: ['stable-4.22', 'fast-5.0'] }),
      'fast-5.0': graph(
        [
          ['4.22.20', '5.0.0'],
          ['5.0.2', '5.0.3'],
        ],
        { channels: ['fast-5.0', 'stable-5.0'] },
      ),
      'stable-5.0': graph([['5.0.0', '5.0.2']], { channels: ['stable-5.0'] }),
    });
    const result = await stitchAndFindPath(loader, { targetChannel: 'stable-4.22', arch: 'amd64', start: v('4.22.20'), target: v('5.0.3') });
    if (!result.ok) throw new Error(result.error.kind);

    render(
      <PathResult
        result={{ status: 'success', value: result.value, retry: () => {} }}
        channel="stable-4.22"
        channelNames={[]}
        pinnedStops={[]}
        onUseLowerRisk={() => {}}
      />,
    );

    expect(screen.getByText(/Assembled across channels/).parentElement?.textContent).toBe(
      'Assembled across channels: stable-4.22 → fast-5.0 → stable-5.0 → fast-5.0',
    );
  });
});
