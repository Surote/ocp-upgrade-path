import { describe, expect, it } from 'vitest';
import { stitchAndFindPath } from '../stitch';
import { graph, loaderFor, v } from './routeFixtures';

describe('look-ahead discovery keeps every channel a route may need', () => {
  it('keeps a fallback the walk reached before a preferred channel named its stream', async () => {
    // stable-5.0 is named only by fast-5.0, and only stable-5.0 names stable-5.1.
    const fetched: string[] = [];
    const loader = loaderFor(
      {
        'stable-4.22': graph([], { nodes: ['4.22.20'], channels: ['stable-4.22', 'fast-5.0'] }),
        'fast-5.0': graph([['4.22.20', '5.0.0']], { channels: ['fast-5.0', 'stable-5.0', 'fast-5.1'] }),
        'stable-5.0': graph([['5.0.0', '5.0.3']], { channels: ['stable-5.0', 'stable-5.1'] }),
        'stable-5.1': graph([['5.0.3', '5.1.0']], { channels: ['stable-5.1'] }),
        'fast-5.1': graph([['5.0.0', '5.1.2']], { channels: ['fast-5.1'] }),
      },
      fetched,
    );

    const result = await stitchAndFindPath(loader, { targetChannel: 'stable-4.22', arch: 'amd64', start: v('4.22.20'), target: v('5.1.2') });

    if (!result.ok) throw new Error(`${result.error.kind}; fetched ${fetched.join(' ')}`);
    expect(result.value.primary.hops.map((h) => [h.to, h.sourceChannel])).toEqual([
      [v('5.0.0'), 'fast-5.0'],
      [v('5.1.2'), 'fast-5.1'],
    ]);
  });

  it('keeps a fallback named after a preferred channel of its stream was found', async () => {
    // stable-5.0 names stable-5.2 before fast-5.1 names fast-5.2; only fast-5.2 holds the target.
    const fetched: string[] = [];
    const loader = loaderFor(
      {
        'stable-4.22': graph([], { nodes: ['4.22.20'], channels: ['stable-4.22', 'fast-5.0'] }),
        'fast-5.0': graph([['4.22.20', '5.0.0']], { channels: ['fast-5.0', 'stable-5.0', 'fast-5.1'] }),
        'stable-5.0': graph([['5.0.0', '5.0.3']], { channels: ['stable-5.0', 'stable-5.2'] }),
        'fast-5.1': graph([['5.0.0', '5.1.0']], { channels: ['fast-5.1', 'fast-5.2'] }),
        'stable-5.2': graph([['5.1.9', '5.2.0']], { channels: ['stable-5.2'] }),
        'fast-5.2': graph([['5.1.0', '5.2.1']], { channels: ['fast-5.2'] }),
      },
      fetched,
    );

    const result = await stitchAndFindPath(loader, { targetChannel: 'stable-4.22', arch: 'amd64', start: v('4.22.20'), target: v('5.2.1') });

    if (!result.ok) throw new Error(`${result.error.kind}; fetched ${fetched.join(' ')}`);
    expect(result.value.primary.hops.map((h) => [h.to, h.sourceChannel])).toEqual([
      [v('5.0.0'), 'fast-5.0'],
      [v('5.1.0'), 'fast-5.1'],
      [v('5.2.1'), 'fast-5.2'],
    ]);
  });

  it('says the preferred channel could not be checked when its fetch failed after a fallback reached the stream', async () => {
    const loader = loaderFor({
      'stable-4.22': graph([], { nodes: ['4.22.20'], channels: ['stable-4.22', 'fast-5.0'] }),
      'fast-5.0': graph([['4.22.20', '5.0.1']], { channels: ['fast-5.0', 'stable-5.0'] }),
      'stable-5.0': { kind: 'network', message: 'Service Unavailable', status: 503 },
    });

    const result = await stitchAndFindPath(loader, { targetChannel: 'stable-4.22', arch: 'amd64', start: v('4.22.20'), target: v('5.0.1') });

    if (!result.ok) throw new Error(result.error.kind);
    expect(result.value.stitch.classFallbacks).toEqual([{ channel: 'fast-5.0', requestedClass: 'stable', requestedStatus: 'unverified' }]);
  });
});

describe('route search across channels of one stream', () => {
  it('returns to a fallback channel after a hop only the preferred channel of the same stream publishes', async () => {
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
    expect(result.value.primary.hops.map((h) => [h.to, h.sourceChannel])).toEqual([
      [v('5.0.0'), 'fast-5.0'],
      [v('5.0.2'), 'stable-5.0'],
      [v('5.0.3'), 'fast-5.0'],
    ]);
  });
});
