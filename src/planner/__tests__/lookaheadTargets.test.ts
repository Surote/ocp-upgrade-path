import { describe, expect, it } from 'vitest';
import { GraphClient } from '../../graph/client';
import type { Version } from '../../graph/types';
import { fakeFetch, fakeJsonResponse } from '../../test-utils/fakeFetch';
import { FakeStorage } from '../../test-utils/fakeStorage';
import { buildGraph } from '../../test-utils/buildGraph';
import { loadFixture } from '../../test-utils/fixtures';
import { buildLookaheadTargetOptions, discoverLookaheadSegments } from '../lookaheadTargets';

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

describe('discoverLookaheadSegments', () => {
  it('makes no network calls at all for a channel name that does not match the <class>-<major>.<minor> convention', async () => {
    const client = makeClient(new Map()) as GraphClient & { __calls: string[] };
    const segments = await discoverLookaheadSegments(client, 'chan-a', 'amd64');
    expect(segments).toEqual([]);
    expect(client.__calls).toEqual([]);
  });

  it('fetches only newer channels the anchor\'s membership names, preferring the anchor\'s class at each stream', async () => {
    const membership = ['eus-4.20', 'stable-4.20', 'stable-4.21', 'eus-4.22', 'stable-4.22'];
    const client = makeClient(
      new Map([
        ['eus-4.20|amd64', jsonHandler(rawGraphJson(['4.19.0', '4.20.0'], [[0, 1]], membership))],
        ['stable-4.21|amd64', jsonHandler(rawGraphJson(['4.20.0', '4.21.5'], [[0, 1]]))],
        ['eus-4.22|amd64', jsonHandler(rawGraphJson(['4.20.0', '4.22.9'], [[0, 1]]))],
      ]),
    ) as GraphClient & { __calls: string[] };

    const segments = await discoverLookaheadSegments(client, 'eus-4.20', 'amd64');

    expect(segments.map((s) => [s.channel, s.classFallback, s.requestedClass])).toEqual([
      ['stable-4.21', true, 'eus'],
      ['eus-4.22', false, undefined],
    ]);
    expect(client.__calls).toEqual(['eus-4.20', 'stable-4.21', 'eus-4.22']);
  });

  it('fetches nothing beyond the anchor when its membership names no newer stream', async () => {
    const client = makeClient(
      new Map([['stable-4.20|amd64', jsonHandler(rawGraphJson(['4.19.0', '4.20.0'], [[0, 1]], ['stable-4.19', 'stable-4.20']))]]),
    ) as GraphClient & { __calls: string[] };
    expect(await discoverLookaheadSegments(client, 'stable-4.20', 'amd64')).toEqual([]);
    expect(client.__calls).toEqual(['stable-4.20']);
  });

  it('fetches at most three newer streams', async () => {
    const newer = ['stable-4.21', 'stable-4.22', 'stable-4.23', 'stable-4.24', 'stable-5.0'];
    const handlers = new Map<string, Handler>([
      ['stable-4.20|amd64', jsonHandler(rawGraphJson(['4.20.0'], [], ['stable-4.20', ...newer]))],
      ...newer.map((c) => [`${c}|amd64`, jsonHandler(rawGraphJson(['4.20.0', `${c.slice(7)}.0`], [[0, 1]]))] as const),
    ]);
    const client = makeClient(handlers) as GraphClient & { __calls: string[] };
    const segments = await discoverLookaheadSegments(client, 'stable-4.20', 'amd64');
    expect(segments.map((s) => s.channel)).toEqual(['stable-4.21', 'stable-4.22', 'stable-4.23']);
  });

  it('stops discovery (without throwing) on a genuine network failure', async () => {
    const fetchImpl = fakeFetch(async () => {
      throw new Error('network down');
    });
    const brokenClient = new GraphClient({ storage: new FakeStorage(), fetchImpl });
    expect(await discoverLookaheadSegments(brokenClient, 'eus-4.20', 'amd64')).toEqual([]);
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
    const segments = await discoverLookaheadSegments(client, 'stable-4.22', 'amd64');
    const anchor = await client.getGraph({ channel: 'stable-4.22', arch: 'amd64' });
    if (!anchor.ok) throw new Error('anchor fixture did not load');

    const options = buildLookaheadTargetOptions(anchor.value.graph, v('4.22.3'), segments);
    const rc8 = options.find((o) => o.version === v('5.0.0-rc.8'));

    expect(rc8).toEqual({ version: v('5.0.0-rc.8'), disabled: false, reason: undefined, viaChannel: 'candidate-5.0', classFallback: true });
  });
});

describe('buildLookaheadTargetOptions', () => {
  it('lists a version from a look-ahead segment as reachable when the anchor and segment share an overlapping, start-reachable version', () => {
    const anchor = buildGraph(['4.18.0', '4.19.0', '4.20.0'], [[0, 1], [1, 2]]);
    const forward = buildGraph(['4.20.0', '4.21.0', '4.22.9'], [[0, 1], [1, 2]]);
    const options = buildLookaheadTargetOptions(anchor, v('4.18.0'), [
      { channel: 'eus-4.22', graph: forward, classFallback: false },
    ]);

    const target = options.find((o) => o.version === v('4.22.9'));
    expect(target).toBeDefined();
    expect(target?.disabled).toBe(false);
    expect(target?.viaChannel).toBe('eus-4.22');
    expect(target?.classFallback).toBe(false);
  });

  it('excludes versions already present in the anchor graph -- those belong to the in-channel list, not here', () => {
    const anchor = buildGraph(['4.18.0', '4.20.0'], [[0, 1]]);
    const forward = buildGraph(['4.20.0', '4.22.0'], [[0, 1]]);
    const options = buildLookaheadTargetOptions(anchor, v('4.18.0'), [
      { channel: 'eus-4.22', graph: forward, classFallback: false },
    ]);
    expect(options.map((o) => o.version)).not.toContain(v('4.20.0'));
  });

  it('marks a look-ahead version unreachable, with a reason, when the segment does not connect back to the reachable frontier', () => {
    const anchor = buildGraph(['4.18.0', '4.19.0'], [[0, 1]]);
    // forward shares NO version with anchor -- no legitimate join point.
    const forward = buildGraph(['4.20.5', '4.21.0'], [[0, 1]]);
    const options = buildLookaheadTargetOptions(anchor, v('4.18.0'), [
      { channel: 'stable-4.21', graph: forward, classFallback: false },
    ]);
    expect(options.every((o) => o.disabled)).toBe(true);
    expect(options[0]?.reason).toBeTruthy();
  });

  it('surfaces the class fallback flag through to the option so the UI can call it out', () => {
    const anchor = buildGraph(['4.18.0', '4.20.0'], [[0, 1]]);
    const forward = buildGraph(['4.20.0', '4.21.5'], [[0, 1]]);
    const options = buildLookaheadTargetOptions(anchor, v('4.18.0'), [
      { channel: 'stable-4.21', graph: forward, classFallback: true, requestedClass: 'eus' },
    ]);
    const target = options.find((o) => o.version === v('4.21.5'));
    expect(target?.classFallback).toBe(true);
  });

  it('carries the reachable frontier across multiple chained segments', () => {
    const anchor = buildGraph(['4.18.0', '4.20.0'], [[0, 1]]);
    const seg1 = buildGraph(['4.20.0', '4.21.0'], [[0, 1]]); // reachable from anchor
    const seg2 = buildGraph(['4.21.0', '4.22.9'], [[0, 1]]); // reachable via seg1
    const options = buildLookaheadTargetOptions(anchor, v('4.18.0'), [
      { channel: 'eus-4.21', graph: seg1, classFallback: false },
      { channel: 'eus-4.22', graph: seg2, classFallback: false },
    ]);
    const target = options.find((o) => o.version === v('4.22.9'));
    expect(target?.disabled).toBe(false);
  });

  it('joins a later segment directly to the anchor when an earlier segment is a sibling stream, not a link', () => {
    // 4.23 and 5.0 both follow 4.22; 5.0 must not have to pass through 4.23.
    const anchor = buildGraph(['4.22.0', '4.22.1', '4.22.5'], [[0, 1], [0, 2]]);
    const seg423 = buildGraph(['4.22.1', '4.23.0-ec.0'], [[0, 1]]);
    const seg50 = buildGraph(['4.22.5', '5.0.0-rc.1'], [[0, 1]]);
    const options = buildLookaheadTargetOptions(anchor, v('4.22.0'), [
      { channel: 'candidate-4.23', graph: seg423, classFallback: true, requestedClass: 'stable' },
      { channel: 'candidate-5.0', graph: seg50, classFallback: true, requestedClass: 'stable' },
    ]);
    expect(options.find((o) => o.version === v('5.0.0-rc.1'))?.disabled).toBe(false);
  });

  it('is sorted newest first', () => {
    const anchor = buildGraph(['4.18.0'], []);
    const forward = buildGraph(['4.18.0', '4.19.0', '4.20.0'], [[0, 1], [1, 2]]);
    const options = buildLookaheadTargetOptions(anchor, v('4.18.0'), [
      { channel: 'stable-4.20', graph: forward, classFallback: false },
    ]);
    expect(options.map((o) => o.version)).toEqual([v('4.20.0'), v('4.19.0')]);
  });
});
