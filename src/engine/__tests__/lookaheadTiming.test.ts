import { describe, expect, it } from 'vitest';
import { parseChannelName } from '../../design/channels';
import { candidateChannelsForStream } from '../../design/forwardChannel';
import type { GraphError } from '../../graph/errors';
import type { Graph } from '../../graph/types';
import { discoverLookahead } from '../lookahead';
import type { GraphLoader } from '../types';
import { compareStreams } from '../version';
import { graph, loaderFor } from './routeFixtures';

const CAP = 48;

/** The channels a walk that fetches one channel at a time takes, with no cap. */
async function serialWalk(loader: GraphLoader, anchorGraph: Graph): Promise<string[]> {
  const anchor = parseChannelName('stable-4.5') as NonNullable<ReturnType<typeof parseChannelName>>;
  const rank = (name: string) => {
    const parsed = parseChannelName(name);
    return parsed && compareStreams(parsed, anchor) > 0 ? candidateChannelsForStream('stable', { major: parsed.major, minor: parsed.minor }).indexOf(name) : -1;
  };
  const attested = new Set(anchorGraph.channelNames);
  const tried: string[] = [];
  for (;;) {
    const next = [...attested]
      .filter((name) => rank(name) >= 0 && !tried.includes(name))
      .sort((a, b) => compareStreams(parseChannelName(a)!, parseChannelName(b)!) || rank(a) - rank(b))[0];
    if (!next) return tried;
    tried.push(next);
    const result = await loader(next, 'amd64');
    if (result.ok) for (const name of result.value.channelNames) attested.add(name);
  }
}

function prng(seed: number) {
  let state = seed;
  return () => (state = (state * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
}

/** `calls` records each call when it is made, before its delay. */
function delayed(loader: GraphLoader, delayFor: (channel: string) => number, calls: string[] = []): GraphLoader {
  return async (channel, arch) => {
    calls.push(channel);
    await new Promise((resolve) => setTimeout(resolve, delayFor(channel)));
    return loader(channel, arch);
  };
}

describe('look-ahead discovery does not depend on response timing', () => {
  it('takes the same channels from random graphs whatever the response delays, a serial walk\'s when that fits the cap', async () => {
    const rnd = prng(7);
    const universe = Array.from({ length: 25 }, (_, i) => ['stable', 'fast', 'candidate'].map((cls) => `${cls}-4.${i + 6}`)).flat();
    const pick = (k: number) => Array.from({ length: k }, () => universe[Math.floor(rnd() * universe.length)] as string);
    let capBound = 0;
    for (let trial = 0; trial < 300; trial += 1) {
      const fan = 1 + Math.floor(rnd() * 6);
      const graphs: Record<string, Graph | GraphError> = {};
      for (const name of universe) {
        const r = rnd();
        if (r < 0.2) continue;
        graphs[name] = r < 0.25 ? { kind: 'network', message: 'Bad Gateway', status: 502 } : graph([], { nodes: ['4.5.1'], channels: [name, ...pick(fan)] });
      }
      const anchor = graph([], { nodes: ['4.5.0'], channels: ['stable-4.5', ...pick(fan * 2)] });
      const serial = await serialWalk(loaderFor(graphs), anchor);

      const runs = [];
      for (const schedule of [0, 1, 2]) {
        const fetched: string[] = [];
        const jitter = prng(trial * 3 + schedule + 1);
        const discovery = await discoverLookahead(delayed(loaderFor(graphs), () => jitter() * 4, fetched), 'stable-4.5', anchor, 'amd64');
        expect(fetched.length).toBeLessThanOrEqual(CAP);
        runs.push({ tried: discovery.channelsTried, segments: discovery.segments.map((s) => s.channel), fetched: [...fetched].sort() });
      }
      expect(runs[1], `trial ${trial}`).toEqual(runs[0]);
      expect(runs[2], `trial ${trial}`).toEqual(runs[0]);
      if (serial.length <= CAP) expect(runs[0]?.tried, `trial ${trial}`).toEqual(serial);
      else capBound += 1;
    }
    expect(capBound).toBeGreaterThan(0);
  }, 60000);

  it('keeps the channels a slow first channel reveals ahead of 46 fetched ones, as when it answers fast', async () => {
    // The anchor names 47 channels. stable-4.6, taken first, names fast-4.6 and candidate-4.6, which come before every other.
    const filler = Array.from({ length: 15 }, (_, i) => ['stable', 'fast', 'candidate'].map((cls) => `${cls}-4.${i + 7}`)).flat();
    const named = ['stable-4.6', ...filler, 'stable-4.22'];
    const graphs: Record<string, Graph> = Object.fromEntries(named.map((name) => [name, graph([], { nodes: ['4.6.1'], channels: [name] })]));
    graphs['stable-4.6'] = graph([], { nodes: ['4.6.1'], channels: ['stable-4.6', 'fast-4.6', 'candidate-4.6'] });
    graphs['fast-4.6'] = graph([], { nodes: ['4.6.2'], channels: ['fast-4.6'] });
    graphs['candidate-4.6'] = graph([], { nodes: ['4.6.3'], channels: ['candidate-4.6'] });
    const anchor = graph([], { nodes: ['4.5.0'], channels: ['stable-4.5', ...named] });

    const fast = await discoverLookahead(delayed(loaderFor(graphs), () => 1), 'stable-4.5', anchor, 'amd64');
    const fetched: string[] = [];
    const slow = await discoverLookahead(delayed(loaderFor(graphs), (c) => (c === 'stable-4.6' ? 30 : 1), fetched), 'stable-4.5', anchor, 'amd64');

    expect(fast.channelsTried.slice(0, 3)).toEqual(['stable-4.6', 'fast-4.6', 'candidate-4.6']);
    expect(fast.segments).toHaveLength(CAP);
    expect(slow.segments.map((s) => s.channel)).toEqual(fast.segments.map((s) => s.channel));
    expect(fetched.length).toBeLessThanOrEqual(CAP);
  });
});
