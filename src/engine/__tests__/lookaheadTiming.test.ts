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
  const ranks = new Map<string, number>();
  const rank = (name: string) => {
    let known = ranks.get(name);
    if (known === undefined) {
      const parsed = parseChannelName(name);
      known = parsed && compareStreams(parsed, anchor) > 0 ? candidateChannelsForStream('stable', { major: parsed.major, minor: parsed.minor }).indexOf(name) : -1;
      ranks.set(name, known);
    }
    return known;
  };
  const precedes = (a: string, b: string) => compareStreams(parseChannelName(a)!, parseChannelName(b)!) || rank(a) - rank(b);
  const attested = new Set(anchorGraph.channelNames);
  const tried = new Set<string>();
  for (;;) {
    let next: string | undefined;
    for (const name of attested) if (rank(name) >= 0 && !tried.has(name) && (next === undefined || precedes(name, next) < 0)) next = name;
    if (!next) return [...tried];
    tried.add(next);
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

const settle = () => new Promise((resolve) => setImmediate(resolve));

/**
 * Runs a discovery whose loader calls answer only when the test answers them:
 * once the discovery has done all it can, `pick` chooses which waiting call
 * answers next. Calls still waiting after the discovery returns answer too,
 * so `fetched` holds every call it ever makes.
 */
async function scheduled(graphs: Readonly<Record<string, Graph | GraphError>>, anchor: Graph, pick: (waiting: number) => number) {
  const inner = loaderFor(graphs);
  const waiting: (() => void)[] = [];
  const fetched: string[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const loader: GraphLoader = (channel, arch) => {
    fetched.push(channel);
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    return new Promise((resolve) =>
      waiting.push(() => {
        inFlight -= 1;
        resolve(inner(channel, arch));
      }),
    );
  };
  let discovery: Awaited<ReturnType<typeof discoverLookahead>> | undefined;
  void discoverLookahead(loader, 'stable-4.5', anchor, 'amd64').then((d) => (discovery = d));
  for (await settle(); waiting.length > 0; await settle()) waiting.splice(pick(waiting.length), 1)[0]?.();
  if (!discovery) throw new Error('discovery waits on no loader call');
  return { discovery, fetched, maxInFlight };
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
        const order = prng(trial * 3 + schedule + 1);
        const { discovery, fetched } = await scheduled(graphs, anchor, (n) => Math.floor(order() * n));
        expect(fetched.length).toBeLessThanOrEqual(CAP);
        runs.push({ tried: discovery.channelsTried, segments: discovery.segments.map((s) => s.channel), fetched: [...fetched].sort() });
      }
      expect(runs[1], `trial ${trial}`).toEqual(runs[0]);
      expect(runs[2], `trial ${trial}`).toEqual(runs[0]);
      if (serial.length <= CAP) expect(runs[0]?.tried, `trial ${trial}`).toEqual(serial);
      else capBound += 1;
    }
    expect(capBound).toBeGreaterThan(0);
  });

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
