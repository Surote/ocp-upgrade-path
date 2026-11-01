import { describe, expect, it } from 'vitest';
import { GraphClient } from '../../graph/client';
import type { Version } from '../../graph/types';
import { fakeFetch, fakeJsonResponse } from '../../test-utils/fakeFetch';
import { FakeStorage } from '../../test-utils/fakeStorage';
import { buildGraph } from '../../test-utils/buildGraph';
import { buildLookaheadTargetOptions, discoverLookaheadSegments } from '../lookaheadTargets';

function v(s: string): Version {
  return s as Version;
}

function rawGraphJson(versions: readonly string[], edges: ReadonlyArray<readonly [number, number]>): unknown {
  return {
    version: 1,
    nodes: versions.map((version, i) => ({
      version,
      payload: `quay.io/openshift-release-dev/ocp-release@sha256:${i.toString().padStart(64, '0')}`,
      metadata: { url: `https://access.redhat.com/errata/TEST-${i}` },
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

  it('walks forward, same class first, and stops the first minor where neither the class nor stable exists', async () => {
    const eus22 = rawGraphJson(['4.20.0', '4.22.9'], [[0, 1]]);
    const client = makeClient(
      new Map([
        ['eus-4.22|amd64', jsonHandler(eus22)],
        // eus-4.21 and stable-4.21 both fall through to the default "doesn't exist" handler.
      ]),
    ) as GraphClient & { __calls: string[] };

    const segments = await discoverLookaheadSegments(client, 'eus-4.20', 'amd64');

    // Step 1 (minor 21): both eus-4.21 and stable-4.21 are empty -- discovery
    // stops there rather than skipping ahead to try minor 22 anyway.
    expect(client.__calls).toEqual(['eus-4.21', 'stable-4.21']);
    expect(segments).toEqual([]);
  });

  it('records a same-class hit with no fallback flag when the anchor class itself exists at that minor', async () => {
    const eus21 = rawGraphJson(['4.20.0', '4.21.9'], [[0, 1]]);
    const client = makeClient(new Map([['eus-4.21|amd64', jsonHandler(eus21)]])) as GraphClient & { __calls: string[] };

    const segments = await discoverLookaheadSegments(client, 'eus-4.20', 'amd64');

    expect(client.__calls[0]).toBe('eus-4.21');
    expect(segments[0]?.channel).toBe('eus-4.21');
    expect(segments[0]?.classFallback).toBe(false);
    expect(segments[0]?.requestedClass).toBeUndefined();
  });

  it('records a stable fallback when the anchor class has no channel at that minor', async () => {
    const stable21 = rawGraphJson(['4.20.0', '4.21.5'], [[0, 1]]);
    const client = makeClient(new Map([['stable-4.21|amd64', jsonHandler(stable21)]])) as GraphClient & { __calls: string[] };

    const segments = await discoverLookaheadSegments(client, 'eus-4.20', 'amd64');

    // Same class tried first at minor 21; found via the stable fallback.
    // Discovery keeps walking outward (minor 22) since nothing bounds it to
    // stop at the first hit, then gives up there since neither variant
    // exists that far out.
    expect(client.__calls).toEqual(['eus-4.21', 'stable-4.21', 'eus-4.22', 'stable-4.22']);
    expect(segments).toHaveLength(1);
    expect(segments[0]?.channel).toBe('stable-4.21');
    expect(segments[0]?.classFallback).toBe(true);
    expect(segments[0]?.requestedClass).toBe('eus');
  });

  it('probes at most a bounded number of extra minors -- never every channel in existence', async () => {
    // Nothing beyond the anchor exists at all; every probe hits the default
    // "doesn't exist" handler. Discovery must give up quickly, not hang or
    // loop unboundedly.
    const client = makeClient(new Map()) as GraphClient & { __calls: string[] };
    const segments = await discoverLookaheadSegments(client, 'stable-4.20', 'amd64');
    expect(segments).toEqual([]);
    // `stable` never needs the fallback candidate, so this is exactly one
    // probe (the immediate next minor) before giving up.
    expect(client.__calls).toEqual(['stable-4.21']);
  });

  it('stops discovery (without throwing) on a genuine network failure rather than a "channel does not exist" response', async () => {
    const fetchImpl = fakeFetch(async () => {
      throw new Error('network down');
    });
    const brokenClient = new GraphClient({ storage: new FakeStorage(), fetchImpl });
    const segments = await discoverLookaheadSegments(brokenClient, 'eus-4.20', 'amd64');
    expect(segments).toEqual([]);
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

  it('is sorted newest first', () => {
    const anchor = buildGraph(['4.18.0'], []);
    const forward = buildGraph(['4.18.0', '4.19.0', '4.20.0'], [[0, 1], [1, 2]]);
    const options = buildLookaheadTargetOptions(anchor, v('4.18.0'), [
      { channel: 'stable-4.20', graph: forward, classFallback: false },
    ]);
    expect(options.map((o) => o.version)).toEqual([v('4.20.0'), v('4.19.0')]);
  });
});
