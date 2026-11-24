import { describe, expect, it } from 'vitest';
import type { GraphError } from '../../graph/errors';
import type { Graph } from '../../graph/types';
import { discoverLookahead } from '../lookahead';
import { stitchAndFindPath } from '../stitch';
import type { GraphLoader } from '../types';
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

  it('still fetches a preferred channel named after another channel of its stream failed to load', async () => {
    // Only stable-5.0 names stable-4.23, and candidate-4.23 is tried first.
    const loader = loaderFor({
      'stable-4.22': graph([], { nodes: ['4.22.20'], channels: ['stable-4.22', 'candidate-4.23', 'stable-5.0'] }),
      'candidate-4.23': { kind: 'network', message: 'Service Unavailable', status: 503 },
      'stable-5.0': graph([['4.22.20', '5.0.0']], { channels: ['stable-5.0', 'stable-4.23'] }),
      'stable-4.23': graph([['4.22.20', '4.23.1']], { channels: ['stable-4.23'] }),
    });

    const result = await stitchAndFindPath(loader, { targetChannel: 'stable-4.22', arch: 'amd64', start: v('4.22.20'), target: v('4.23.1') });

    if (!result.ok) throw new Error(result.error.kind);
    expect(result.value.primary.hops.map((h) => [h.to, h.sourceChannel])).toEqual([[v('4.23.1'), 'stable-4.23']]);
    expect(result.value.stitch.classFallbacks).toEqual([]);
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

describe('look-ahead discovery fetches concurrently', () => {
  // Every stream's channels are named by the stream before it, so each stream is one wave.
  const streams = ['4.15', '4.16', '4.17', '4.18'];
  const names = (s: string) => ['stable', 'fast', 'candidate'].map((cls) => `${cls}-${s}`);
  const graphs: Record<string, Graph | GraphError> = { 'fast-4.17': { kind: 'network', message: 'Bad Gateway', status: 502 } };
  streams.forEach((s, i) => {
    for (const name of names(s)) {
      if (graphs[name]) continue;
      graphs[name] = graph([], { nodes: [`${s}.${name.length}`], channels: [name, ...(streams[i + 1] ? names(streams[i + 1] as string) : [])] });
    }
  });
  const anchor = graph([], { nodes: ['4.14.0'], channels: ['stable-4.14', ...names('4.15')] });

  function delayedLoader(delayFor: (channel: string) => number) {
    const stats = { inFlight: 0, maxInFlight: 0 };
    const inner = loaderFor(graphs);
    const loader: GraphLoader = async (channel, arch) => {
      stats.inFlight += 1;
      stats.maxInFlight = Math.max(stats.maxInFlight, stats.inFlight);
      await new Promise((resolve) => setTimeout(resolve, delayFor(channel)));
      stats.inFlight -= 1;
      return inner(channel, arch);
    };
    return { loader, stats };
  }

  it('fetches the channels of a frontier at the same time, a bounded number at once', async () => {
    const { loader, stats } = delayedLoader(() => 5);

    await discoverLookahead(loader, 'stable-4.14', anchor, 'amd64');

    expect(stats.maxInFlight).toBeGreaterThan(1);
    expect(stats.maxInFlight).toBeLessThanOrEqual(6);
  });

  it('returns the same discovery whatever order the fetches finish in', async () => {
    const order = Object.keys(graphs);
    const fastFirst = await discoverLookahead(delayedLoader((c) => order.indexOf(c)).loader, 'stable-4.14', anchor, 'amd64');
    const slowFirst = await discoverLookahead(delayedLoader((c) => 12 - order.indexOf(c)).loader, 'stable-4.14', anchor, 'amd64');

    expect(slowFirst).toEqual(fastFirst);
    expect(fastFirst.segments.map((s) => s.channel)).toEqual(
      streams.flatMap((s) => names(s).reverse().filter((n) => n !== 'fast-4.17')),
    );
    expect(fastFirst.failure?.channel).toBe('fast-4.17');
  });
});

describe('look-ahead discovery near the fetch cap', () => {
  it('spends the last fetches on the channels a one-at-a-time walk would, even when a fetched graph reorders them', async () => {
    // The anchor names 46 empty or near-empty channels, leaving two of the 48 fetches.
    // stable-4.21 names stable-4.22 and fast-4.22; stable-4.22 then names candidate-4.21,
    // an earlier stream, so a one-at-a-time walk fetches it before fast-4.22.
    const filler = Array.from({ length: 15 }, (_, i) => ['stable', 'fast', 'candidate'].map((cls) => `${cls}-4.${i + 6}`)).flat();
    const anchor = graph([], { nodes: ['4.5.0'], channels: ['stable-4.5', ...filler, 'stable-4.21'] });
    const loader = loaderFor({
      'stable-4.21': graph([['4.20.1', '4.21.1']], { channels: ['stable-4.21', 'stable-4.22', 'fast-4.22'] }),
      'stable-4.22': graph([['4.21.1', '4.22.1']], { channels: ['stable-4.22', 'candidate-4.21'] }),
      'fast-4.22': graph([['4.21.1', '4.22.2']], { channels: ['fast-4.22'] }),
      'candidate-4.21': graph([['4.20.1', '4.21.2']], { channels: ['candidate-4.21'] }),
    });

    const discovery = await discoverLookahead(loader, 'stable-4.5', anchor, 'amd64');

    expect(discovery.channelsTried).toHaveLength(48);
    expect(discovery.channelsTried.slice(-2)).toEqual(['stable-4.22', 'candidate-4.21']);
    expect(discovery.segments.map((s) => s.channel)).toEqual(['candidate-4.21', 'stable-4.21', 'stable-4.22']);
  });
});
