import { describe, expect, it } from 'vitest';
import { GraphClient } from '../../graph/client';
import type { Version } from '../../graph/types';
import { fakeFetch, fakeJsonResponse } from '../../test-utils/fakeFetch';
import { FakeStorage } from '../../test-utils/fakeStorage';
import { loadFixture } from '../../test-utils/fixtures';
import { discoverLookahead } from '../../engine/lookahead';
import { parseRawGraph } from '../../graph/parse';
import { makeGraphLoader } from '../graphLoader';
import { buildTargetOptions } from '../targetOptions';

function v(s: string): Version {
  return s as Version;
}

const CHANNELS_KEY = 'io.openshift.upgrades.graph.release.channels';

/** `channels` is the membership every node advertises -- the data discovery reads successor streams from. */
function rawGraphJson(
  versions: readonly string[],
  edges: ReadonlyArray<readonly [number, number]>,
  channels: readonly string[] = [],
): unknown {
  return {
    version: 1,
    nodes: versions.map((version, i) => ({
      version,
      payload: `quay.io/openshift-release-dev/ocp-release@sha256:${i.toString().padStart(64, '0')}`,
      metadata: { url: `https://access.redhat.com/errata/TEST-${i}`, [CHANNELS_KEY]: channels.join(',') },
    })),
    edges: edges.map(([a, b]) => [a, b]),
    conditionalEdges: [],
  };
}

type Handler = () => Promise<Response>;

function jsonHandler(body: unknown): Handler {
  return () => Promise.resolve(fakeJsonResponse(body));
}

function makeClient(responses: Map<string, Handler>): GraphClient {
  const calls: string[] = [];
  const fetchImpl = fakeFetch(async (url) => {
    const u = new URL(url);
    const channel = u.searchParams.get('channel') as string;
    const arch = u.searchParams.get('arch');
    calls.push(channel);
    const handler = responses.get(`${channel}|${arch}`);
    if (!handler) return fakeJsonResponse({ version: 1, nodes: [], edges: [], conditionalEdges: [] }); // unregistered = "doesn't exist"
    return handler();
  });
  const client = new GraphClient({ storage: new FakeStorage(), fetchImpl });
  return Object.assign(client, { __calls: calls }) as GraphClient & { __calls: string[] };
}

/** Discovers through `client`'s cache from the anchor graph `client` loads, as the planner does. */
async function discoverLookaheadSegments(client: GraphClient, anchorChannel: string) {
  const anchor = await client.getGraph({ channel: anchorChannel, arch: 'amd64' });
  if (!anchor.ok) throw new Error(`anchor ${anchorChannel} did not load`);
  return (await discoverLookahead(makeGraphLoader(client), anchorChannel, anchor.value.graph, 'amd64')).segments;
}

describe('look-ahead discovery through the graph client', () => {
  it('makes no network calls at all for a channel name that does not match the <class>-<major>.<minor> convention', async () => {
    const client = makeClient(new Map()) as GraphClient & { __calls: string[] };
    const anchor = parseRawGraph(rawGraphJson(['4.20.0'], [], ['stable-4.21']), { channel: 'chan-a', arch: 'amd64' });
    if (!anchor.ok) throw new Error('anchor did not parse');
    const discovery = await discoverLookahead(makeGraphLoader(client), 'chan-a', anchor.value, 'amd64');
    expect(discovery.segments).toEqual([]);
    expect(client.__calls).toEqual([]);
  });

  it('fetches every newer channel the anchor\'s membership names, the anchor\'s class first at each stream', async () => {
    const membership = ['eus-4.20', 'stable-4.20', 'stable-4.21', 'eus-4.22', 'stable-4.22'];
    const client = makeClient(
      new Map([
        ['eus-4.20|amd64', jsonHandler(rawGraphJson(['4.19.0', '4.20.0'], [[0, 1]], membership))],
        ['stable-4.21|amd64', jsonHandler(rawGraphJson(['4.20.0', '4.21.5'], [[0, 1]]))],
        ['eus-4.22|amd64', jsonHandler(rawGraphJson(['4.20.0', '4.22.9'], [[0, 1]]))],
      ]),
    ) as GraphClient & { __calls: string[] };

    const segments = await discoverLookaheadSegments(client, 'eus-4.20');

    expect(segments.map((s) => [s.channel, s.classFallback && s.requestedClass])).toEqual([
      ['stable-4.21', 'eus'],
      ['eus-4.22', false],
    ]);
    expect(client.__calls).toEqual(['eus-4.20', 'stable-4.21', 'eus-4.22', 'stable-4.22']);
  });

  it('fetches nothing beyond the anchor when its membership names no newer stream', async () => {
    const client = makeClient(
      new Map([['stable-4.20|amd64', jsonHandler(rawGraphJson(['4.19.0', '4.20.0'], [[0, 1]], ['stable-4.19', 'stable-4.20']))]]),
    ) as GraphClient & { __calls: string[] };
    expect(await discoverLookaheadSegments(client, 'stable-4.20')).toEqual([]);
    expect(client.__calls).toEqual(['stable-4.20']);
  });

  it('fetches every newer stream membership names, not just the first three', async () => {
    const newer = ['stable-4.21', 'stable-4.22', 'stable-4.23', 'stable-4.24', 'stable-5.0'];
    const handlers = new Map<string, Handler>([
      ['stable-4.20|amd64', jsonHandler(rawGraphJson(['4.20.0'], [], ['stable-4.20', ...newer]))],
      ...newer.map((c) => [`${c}|amd64`, jsonHandler(rawGraphJson(['4.20.0', `${c.slice(7)}.0`], [[0, 1]]))] as const),
    ]);
    const client = makeClient(handlers) as GraphClient & { __calls: string[] };
    const segments = await discoverLookaheadSegments(client, 'stable-4.20');
    expect(segments.map((s) => s.channel)).toEqual(['stable-4.21', 'stable-4.22', 'stable-4.23', 'stable-4.24', 'stable-5.0']);
  });

  it('routes through a stream discovered after a newer one, keeping fetch order in channelsTried', async () => {
    // Only the 5.1 graph names candidate-4.23, so 4.23 is fetched after 5.1.
    const client = makeClient(
      new Map([
        ['stable-4.22|amd64', jsonHandler(rawGraphJson(['4.21.0', '4.22.0'], [[0, 1]], ['stable-4.22', 'candidate-5.1']))],
        ['candidate-5.1|amd64', jsonHandler(rawGraphJson(['4.23.0', '5.1.0'], [[0, 1]], ['candidate-4.23', 'candidate-5.1']))],
        ['candidate-4.23|amd64', jsonHandler(rawGraphJson(['4.22.0', '4.23.0'], [[0, 1]]))],
      ]),
    );
    const anchor = await client.getGraph({ channel: 'stable-4.22', arch: 'amd64' });
    if (!anchor.ok) throw new Error('anchor did not load');
    const discovery = await discoverLookahead(makeGraphLoader(client), 'stable-4.22', anchor.value.graph, 'amd64');

    expect(discovery.channelsTried).toEqual(['candidate-5.1', 'candidate-4.23']);
    const options = buildTargetOptions(anchor.value.graph, v('4.22.0'), discovery.segments);
    expect(options.find((o) => o.version === '5.1.0')).toEqual({
      version: '5.1.0',
      reachable: true,
      via: { channel: 'candidate-5.1', classFallback: true },
    });
  });

  it('records a genuine network failure instead of throwing', async () => {
    const fetchImpl = fakeFetch(async () => {
      throw new Error('network down');
    });
    const brokenClient = new GraphClient({ storage: new FakeStorage(), fetchImpl });
    const anchor = parseRawGraph(rawGraphJson(['4.20.0'], [], ['eus-4.22']), { channel: 'eus-4.20', arch: 'amd64' });
    if (!anchor.ok) throw new Error('anchor did not parse');
    const discovery = await discoverLookahead(makeGraphLoader(brokenClient), 'eus-4.20', anchor.value, 'amd64');
    expect(discovery.segments).toEqual([]);
    expect(discovery.failure?.channel).toBe('eus-4.22');
  });
});

describe('look-ahead across the 4.22 -> 5.0 major boundary (live fixtures)', () => {
  it('surfaces 5.0 targets from a stable-4.22 anchor, via candidate-5.0, marked as a class change', async () => {
    const client = makeClient(
      new Map([
        ['stable-4.22|amd64', jsonHandler(loadFixture('stable-4.22.json'))],
        ['candidate-5.0|amd64', jsonHandler(loadFixture('candidate-5.0.json'))],
      ]),
    );
    const segments = await discoverLookaheadSegments(client, 'stable-4.22');
    const anchor = await client.getGraph({ channel: 'stable-4.22', arch: 'amd64' });
    if (!anchor.ok) throw new Error('anchor fixture did not load');

    const options = buildTargetOptions(anchor.value.graph, v('4.22.3'), segments);
    const rc8 = options.find((o) => o.version === v('5.0.0-rc.8'));

    expect(rc8).toEqual({ version: v('5.0.0-rc.8'), reachable: true, via: { channel: 'candidate-5.0', classFallback: true } });
  });
});
