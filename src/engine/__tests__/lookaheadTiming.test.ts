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
const MAX_IN_FLIGHT = 6;

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
async function scheduled(
  graphs: Readonly<Record<string, Graph | GraphError>>,
  anchor: Graph,
  pick: (waiting: readonly string[]) => number | readonly number[],
) {
  const inner = loaderFor(graphs);
  const waiting: { channel: string; answer: () => void }[] = [];
  const fetched: string[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const loader: GraphLoader = (channel, arch) => {
    fetched.push(channel);
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    return new Promise((resolve) =>
      waiting.push({
        channel,
        answer: () => {
          inFlight -= 1;
          resolve(inner(channel, arch));
        },
      }),
    );
  };
  let discovery: Awaited<ReturnType<typeof discoverLookahead>> | undefined;
  void discoverLookahead(loader, 'stable-4.5', anchor, 'amd64').then((d) => (discovery = d));
  for (await settle(); waiting.length > 0; await settle()) {
    const picked = pick(waiting.map((call) => call.channel));
    // Several picks answer in the same tick, before the discovery resumes.
    const answering = (typeof picked === 'number' ? [picked] : [...picked]).sort((a, b) => b - a).map((i) => waiting.splice(i, 1)[0]);
    for (const call of answering) call?.answer();
  }
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
        const { discovery, fetched, maxInFlight } = await scheduled(graphs, anchor, (waiting) => Math.floor(order() * waiting.length));
        expect(fetched.length).toBeLessThanOrEqual(CAP);
        expect(maxInFlight, `trial ${trial}`).toBeLessThanOrEqual(MAX_IN_FLIGHT);
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

  it('keeps six loader calls in flight at most when a fast answer reveals six channels ahead of five slow ones', async () => {
    const slow = ['stable-4.12', 'stable-4.13', 'stable-4.14', 'stable-4.15', 'stable-4.16'];
    const revealed = ['fast-4.6', 'candidate-4.6', 'stable-4.7', 'stable-4.8', 'stable-4.9', 'stable-4.10'];
    const graphs: Record<string, Graph> = Object.fromEntries([...slow, ...revealed].map((name) => [name, graph([], { nodes: ['4.6.1'], channels: [name] })]));
    graphs['stable-4.6'] = graph([], { nodes: ['4.6.1'], channels: ['stable-4.6', ...revealed] });
    const anchor = graph([], { nodes: ['4.5.0'], channels: ['stable-4.5', 'stable-4.6', ...slow] });

    const inOrder = await scheduled(graphs, anchor, () => 0);
    const slowLast = await scheduled(graphs, anchor, (waiting) => Math.max(0, waiting.findIndex((channel) => !slow.includes(channel))));

    expect(slowLast.maxInFlight).toBeLessThanOrEqual(MAX_IN_FLIGHT);
    expect(slowLast.discovery.channelsTried).toEqual(['stable-4.6', ...revealed, ...slow]);
    expect(slowLast.discovery.channelsTried).toEqual(inOrder.discovery.channelsTried);
  });

  it('keeps the awaited answer\'s slot for the channels it reveals when a prefetch answers in the same tick', async () => {
    const slow = ['stable-4.20', 'stable-4.21', 'stable-4.22', 'stable-4.23', 'stable-4.24'];
    const pushedBack = ['stable-4.12', 'stable-4.13', 'stable-4.14', 'stable-4.15', 'stable-4.16'];
    const ahead = ['candidate-4.6', 'stable-4.7', 'stable-4.8', 'stable-4.9', 'stable-4.10', 'stable-4.11'];
    const graphs: Record<string, Graph> = Object.fromEntries([...slow, ...pushedBack, ...ahead].map((name) => [name, graph([], { nodes: ['4.6.1'], channels: [name] })]));
    graphs['stable-4.6'] = graph([], { nodes: ['4.6.1'], channels: ['stable-4.6', 'fast-4.6', ...pushedBack] });
    graphs['fast-4.6'] = graph([], { nodes: ['4.6.2'], channels: ['fast-4.6', ...ahead] });
    const anchor = graph([], { nodes: ['4.5.0'], channels: ['stable-4.5', 'stable-4.6', ...slow] });

    // fast-4.6 (awaited) and stable-4.20 (a prefetch) answer together; otherwise non-slow calls first.
    const { fetched, maxInFlight } = await scheduled(graphs, anchor, (waiting) => {
      const awaitedAt = waiting.indexOf('fast-4.6');
      const slowAt = waiting.indexOf('stable-4.20');
      if (awaitedAt >= 0 && slowAt >= 0) return [awaitedAt, slowAt];
      return Math.max(0, waiting.findIndex((channel) => !slow.includes(channel)));
    });

    expect(fetched.indexOf('candidate-4.6')).toBeLessThan(fetched.indexOf('stable-4.13'));
    expect(maxInFlight).toBeLessThanOrEqual(MAX_IN_FLIGHT);
  });

  it('requests the channel the walk waits on before prefetches a later graph pushed back', async () => {
    const slow = ['stable-4.20', 'stable-4.21', 'stable-4.22', 'stable-4.23', 'stable-4.24'];
    const pushedBack = ['stable-4.12', 'stable-4.13', 'stable-4.14', 'stable-4.15', 'stable-4.16'];
    const ahead = ['candidate-4.6', 'stable-4.7', 'stable-4.8', 'stable-4.9', 'stable-4.10', 'stable-4.11'];
    const graphs: Record<string, Graph> = Object.fromEntries([...slow, ...pushedBack, ...ahead].map((name) => [name, graph([], { nodes: ['4.6.1'], channels: [name] })]));
    graphs['stable-4.6'] = graph([], { nodes: ['4.6.1'], channels: ['stable-4.6', 'fast-4.6', ...pushedBack] });
    graphs['fast-4.6'] = graph([], { nodes: ['4.6.2'], channels: ['fast-4.6', ...ahead] });
    const anchor = graph([], { nodes: ['4.5.0'], channels: ['stable-4.5', 'stable-4.6', ...slow] });

    const { fetched, maxInFlight } = await scheduled(graphs, anchor, (waiting) => Math.max(0, waiting.findIndex((channel) => !slow.includes(channel))));

    expect(fetched).toEqual(['stable-4.6', ...slow, 'fast-4.6', ...ahead, ...pushedBack]);
    expect(maxInFlight).toBeLessThanOrEqual(MAX_IN_FLIGHT);
  });
});
