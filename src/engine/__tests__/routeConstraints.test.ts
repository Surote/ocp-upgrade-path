import { describe, expect, it } from 'vitest';
import type { Graph, Version } from '../../graph/types';
import type { ChannelSegment } from '../lookahead';
import { buildStopOptions, type RouteConstraints } from '../routeConstraints';
import { stitchAndFindPath } from '../stitch';
import type { GraphLoader } from '../types';
import { graph, loaderFor, type RiskSpec, v } from './routeFixtures';

function versionsOf(result: Awaited<ReturnType<typeof stitchAndFindPath>>): readonly Version[] {
  if (!result.ok) throw new Error(`no route: ${JSON.stringify(result.error)}`);
  return result.value.primary.versions;
}

const noFetch: GraphLoader = async (channel) => {
  throw new Error(`unexpected fetch of ${channel}`);
};

/** Routes on the anchor and look-ahead given, as the planner calls the stitcher. */
function route(segments: readonly ChannelSegment[], start: string, target: string, constraints?: RouteConstraints) {
  const [anchor, ...lookahead] = segments as [ChannelSegment, ...ChannelSegment[]];
  return stitchAndFindPath(noFetch, {
    targetChannel: anchor.channel,
    arch: 'amd64',
    start: v(start),
    target: v(target),
    anchor: { graph: anchor.graph, lookahead: { segments: lookahead, channelsTried: lookahead.map((s) => s.channel) } },
    constraints,
  });
}

function seg(channel: string, g: Graph, requestedClass?: string): ChannelSegment {
  return requestedClass
    ? { channel, graph: g, classFallback: true, requestedClass, requestedStatus: 'noRoute' }
    : { channel, graph: g, classFallback: false };
}

const stops = (...versions: string[]): RouteConstraints => ({ stops: versions.map(v), riskPolicy: 'recommended' });
const avoid = (...versions: string[]): RouteConstraints => ({ stops: versions.map(v), riskPolicy: 'avoidConditional' });

describe('stops', () => {
  const single = [
    seg(
      'stable-4.20',
      graph([
        ['4.18.0', '4.19.10'],
        ['4.19.10', '4.20.0'],
        ['4.18.0', '4.18.5'],
        ['4.18.5', '4.19.20'],
        ['4.19.20', '4.20.0'],
        ['4.18.0', '4.19.20'],
      ]),
    ),
  ];

  it('routes through every stop, in order', async () => {
    expect(versionsOf(await route(single, '4.18.0', '4.20.0'))).toEqual([v('4.18.0'), v('4.19.20'), v('4.20.0')]);
    expect(versionsOf(await route(single, '4.18.0', '4.20.0', stops('4.18.5', '4.19.20')))).toEqual([
      v('4.18.0'),
      v('4.18.5'),
      v('4.19.20'),
      v('4.20.0'),
    ]);
  });

  it('offers no alternate that skips a stop', async () => {
    const result = await route(single, '4.18.0', '4.20.0', stops('4.19.10'));
    if (!result.ok) throw new Error(result.error.kind);
    expect(result.value.primary.versions).toContain(v('4.19.10'));
    expect(result.value.alternates).toEqual({ kind: 'notComputed', reason: 'constrained' });
  });

  it('names the first stop that cannot be honored', async () => {
    expect(await route(single, '4.18.0', '4.20.0', stops('4.19.99'))).toEqual({
      ok: false,
      error: { kind: 'stopUnreachable', index: 0, stop: v('4.19.99') },
    });
    expect(await route(single, '4.18.0', '4.20.0', stops('4.19.20', '4.18.5'))).toEqual({
      ok: false,
      error: { kind: 'stopUnreachable', index: 1, stop: v('4.18.5') },
    });
    expect(await route(single, '4.18.0', '4.20.0', stops('4.18.0'))).toEqual({
      ok: false,
      error: { kind: 'stopUnreachable', index: 0, stop: v('4.18.0') },
    });
  });

  it('keeps reporting an unreachable target as unreachable when stops are set', async () => {
    const result = await route(single, '4.19.10', '4.18.5', stops('4.19.20'));
    expect(result.ok ? 'routed' : result.error.kind).toBe('targetOlder');
  });

  it('switches to a look-ahead channel only before the first hop it supplies', async () => {
    const segments = [
      seg(
        'eus-4.20',
        graph([
          ['4.18.0', '4.19.0'],
          ['4.19.0', '4.20.0'],
          ['4.20.0', '4.20.5'],
        ]),
      ),
      seg(
        'eus-4.22',
        graph([
          ['4.20.0', '4.21.0'],
          ['4.21.0', '4.22.0'],
          ['4.20.5', '4.21.3'],
          ['4.21.3', '4.22.0'],
        ]),
      ),
    ];

    const result = await route(segments, '4.18.0', '4.22.0', stops('4.21.3'));

    if (!result.ok) throw new Error(result.error.kind);
    expect(result.value.primary.hops.map((h) => [h.to, h.sourceChannel])).toEqual([
      [v('4.19.0'), 'eus-4.20'],
      [v('4.20.0'), 'eus-4.20'],
      [v('4.20.5'), 'eus-4.20'],
      [v('4.21.3'), 'eus-4.22'],
      [v('4.22.0'), 'eus-4.22'],
    ]);
  });
});

describe('risk policy', () => {
  const risky = (from: string, to: string, name: string, always = false): RiskSpec => ({ from, to, name, always });

  it('avoidConditional takes a longer route with no conditional risk over a shorter risky one', async () => {
    const segments = [
      seg(
        'stable-4.20',
        graph(
          [
            ['4.18.0', '4.19.0'],
            ['4.19.0', '4.20.0'],
          ],
          { risks: [risky('4.18.0', '4.20.0', 'VSphereRisk')] },
        ),
      ),
    ];

    const recommended = await route(segments, '4.18.0', '4.20.0');
    expect(versionsOf(recommended)).toEqual([v('4.18.0'), v('4.20.0')]);
    if (!recommended.ok) return;
    expect(recommended.value.riskComparison).toEqual({
      route: expect.objectContaining({ versions: [v('4.18.0'), v('4.19.0'), v('4.20.0')] }),
      conditionalFree: true,
    });

    const avoiding = await route(segments, '4.18.0', '4.20.0', avoid());
    expect(versionsOf(avoiding)).toEqual([v('4.18.0'), v('4.19.0'), v('4.20.0')]);
    if (!avoiding.ok) return;
    expect(avoiding.value.riskComparison).toBeUndefined();
  });

  it('counts a risk once per hop it appears on', async () => {
    const segments = [
      seg(
        'stable-4.20',
        graph([['4.19.5', '4.19.6']], {
          risks: [risky('4.18.0', '4.19.0', 'Repeated'), risky('4.19.0', '4.20.0', 'Repeated'), risky('4.18.0', '4.19.5', 'Once'), risky('4.19.6', '4.20.0', 'Second')],
        }),
      ),
    ];
    // Two occurrences each way, so hops decide; without Second the long route carries one.
    const oneOccurrence = [
      seg(
        'stable-4.20',
        graph(
          [
            ['4.19.5', '4.19.6'],
            ['4.19.6', '4.20.0'],
          ],
          { risks: [risky('4.18.0', '4.19.0', 'Repeated'), risky('4.19.0', '4.20.0', 'Repeated'), risky('4.18.0', '4.19.5', 'Once')] },
        ),
      ),
    ];

    expect(versionsOf(await route(segments, '4.18.0', '4.20.0', avoid()))).toEqual([v('4.18.0'), v('4.19.0'), v('4.20.0')]);
    expect(versionsOf(await route(oneOccurrence, '4.18.0', '4.20.0', avoid()))).toEqual([v('4.18.0'), v('4.19.5'), v('4.19.6'), v('4.20.0')]);
  });

  it('ranks Always risks ahead of conditional ones', async () => {
    const segments = [
      seg(
        'stable-4.20',
        graph([], { risks: [risky('4.18.0', '4.20.0', 'Always', true), risky('4.18.0', '4.19.0', 'CondA'), risky('4.19.0', '4.20.0', 'CondB')] }),
      ),
    ];
    expect(versionsOf(await route(segments, '4.18.0', '4.20.0', avoid()))).toEqual([v('4.18.0'), v('4.19.0'), v('4.20.0')]);
  });

  it('never moves onto a fallback class to dodge a risk', async () => {
    // fast-5.0 publishes a clean 5.0.0 -> 5.0.3; stable-5.0, the anchor's class, attaches a risk.
    const loader = loaderFor({
      'stable-4.22': graph([], { nodes: ['4.22.20'], channels: ['stable-4.22', 'fast-5.0'] }),
      'fast-5.0': graph(
        [
          ['4.22.20', '5.0.0'],
          ['5.0.0', '5.0.3'],
        ],
        { channels: ['fast-5.0', 'stable-5.0'] },
      ),
      'stable-5.0': graph([], { risks: [risky('5.0.0', '5.0.3', 'VSphereRisk')], channels: ['stable-5.0'] }),
    });
    const params = { targetChannel: 'stable-4.22', arch: 'amd64', start: v('4.22.20'), target: v('5.0.3') } as const;

    for (const riskPolicy of ['recommended', 'avoidConditional'] as const) {
      const result = await stitchAndFindPath(loader, { ...params, constraints: { stops: [], riskPolicy } });
      if (!result.ok) throw new Error(result.error.kind);
      expect(result.value.primary.hops.map((h) => [h.to, h.sourceChannel])).toEqual([
        [v('5.0.0'), 'fast-5.0'],
        [v('5.0.3'), 'stable-5.0'],
      ]);
      if (riskPolicy === 'recommended') expect(result.value.riskComparison).toEqual({ route: undefined, conditionalFree: false });
    }
  });

  it('reports the recommended route as conditional-free when it already carries no risk', async () => {
    const segments = [seg('stable-4.20', graph([['4.18.0', '4.20.0']], { risks: [risky('4.18.0', '4.19.0', 'Unused')] }))];
    const result = await route(segments, '4.18.0', '4.20.0');
    if (!result.ok) throw new Error(result.error.kind);
    expect(result.value.riskComparison).toEqual({ route: undefined, conditionalFree: true });
  });

  it('compares risk under the same stops', async () => {
    const segments = [
      seg(
        'stable-4.20',
        graph(
          [
            ['4.18.0', '4.19.0'],
            ['4.19.0', '4.20.0'],
            ['4.18.0', '4.18.5'],
            ['4.18.5', '4.19.5'],
          ],
          { risks: [risky('4.19.5', '4.20.0', 'Late'), risky('4.18.5', '4.19.0', 'Early')] },
        ),
      ),
    ];
    const result = await route(segments, '4.18.0', '4.20.0', stops('4.18.5'));
    if (!result.ok) throw new Error(result.error.kind);
    expect(result.value.primary.versions).toContain(v('4.18.5'));
    expect(result.value.riskComparison?.route).toBeUndefined();
    expect(result.value.riskComparison?.conditionalFree).toBe(false);
  });
});

describe('buildStopOptions', () => {
  // Same-stream groups (fast-5.0/stable-5.0), a class fallback, a build of a
  // release, dead ends, and 4.20.8: reachable only through eus-4.22 while its
  // only way on is the earlier-stream stable-4.21.
  const segments: readonly ChannelSegment[] = [
    seg(
      'eus-4.20',
      graph([
        ['4.18.0', '4.18.5'],
        ['4.18.0', '4.19.0'],
        ['4.18.5', '4.18.5+build.1'],
        ['4.18.5+build.1', '4.19.2'],
        ['4.19.0', '4.20.0'],
        ['4.19.2', '4.20.0'],
        ['4.20.0', '4.20.3'],
        ['4.19.0', '4.19.1'],
      ]),
    ),
    seg(
      'stable-4.21',
      graph(
        [
          ['4.20.0', '4.21.0'],
          ['4.20.3', '4.21.1'],
          ['4.21.0', '4.21.4'],
          ['4.21.0', '4.21.9'],
          ['4.20.8', '4.21.4'],
        ],
        { nodes: ['4.20.8'] },
      ),
      'eus',
    ),
    seg(
      'eus-4.22',
      graph([
        ['4.20.3', '4.21.1'],
        ['4.21.1', '4.22.0'],
        ['4.21.4', '4.22.0'],
        ['4.20.0', '4.21.0'],
        ['4.20.3', '4.20.8'],
      ]),
    ),
    seg(
      'fast-5.0',
      graph([
        ['4.22.0', '5.0.0'],
        ['5.0.2', '5.0.3'],
      ]),
      'eus',
    ),
    seg('stable-5.0', graph([['5.0.0', '5.0.2']]), 'eus'),
  ];
  const allVersions = [...new Set(segments.flatMap((s) => s.graph.nodes.map((n) => n.version)))];

  const cases: readonly { readonly target: string; readonly stops: readonly string[] }[] = [
    { target: '5.0.3', stops: [] },
    { target: '5.0.3', stops: ['4.21.1'] },
    { target: '5.0.3', stops: ['4.20.3', '4.22.0'] },
    { target: '5.0.3', stops: ['4.21.4'] },
    { target: '4.20.3', stops: [] },
  ];

  for (const { target, stops: pinned } of cases) {
    for (let gap = 0; gap <= pinned.length; gap += 1) {
      it(`offers exactly the stops that route, ${target} via [${pinned.join(', ')}] at gap ${gap}`, async () => {
        const options = buildStopOptions(segments, v('4.18.0'), v(target), pinned.map(v), gap);
        const offered = new Map(options.map((o) => [o.version, o.channel]));

        for (const candidate of allVersions) {
          if (candidate === '4.18.0' || candidate === target || pinned.includes(candidate)) continue;
          const withStop = [...pinned.slice(0, gap), candidate, ...pinned.slice(gap)];
          const result = await route(segments, '4.18.0', target, stops(...withStop));
          expect([candidate, result.ok]).toEqual([candidate, offered.has(candidate)]);
          if (!result.ok) continue;
          const versions = result.value.primary.versions;
          expect(withStop.map((s) => versions.indexOf(v(s)))).toEqual([...withStop.map((s) => versions.indexOf(v(s)))].sort((a, b) => a - b));
          const arriving = result.value.primary.hops.find((h) => h.to === candidate);
          expect([candidate, offered.get(candidate)]).toEqual([candidate, arriving?.sourceChannel]);
        }
      });
    }
  }

  it('lists newest first and leaves out dead ends and the stream-order trap', () => {
    const options = buildStopOptions(segments, v('4.18.0'), v('5.0.3'), [], 0);
    const versions = options.map((o) => o.version);
    expect(versions).toContain(v('4.18.5+build.1'));
    expect(versions).not.toContain(v('4.21.9'));
    expect(versions).not.toContain(v('4.19.1'));
    expect(versions).not.toContain(v('4.20.8'));
    expect(versions.slice(0, 3)).toEqual([v('5.0.2'), v('5.0.0'), v('4.22.0')]);
  });
});
