import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../App';
import type { RiskComparison, RouteConstraints, StopOption } from '../engine/routeConstraints';
import type { Path } from '../engine/types';
import { GraphClient } from '../graph/client';
import type { Version } from '../graph/types';
import { fakeFetch, fakeJsonResponse } from '../test-utils/fakeFetch';
import { FakeStorage } from '../test-utils/fakeStorage';

// The engine track implements stop options and the risk comparison; these
// tests drive the UI against a controllable stand-in for both, wrapped
// around the real route search.
const engine = vi.hoisted(() => ({
  stopOptions: [] as StopOption[],
  comparison: undefined as RiskComparison | undefined,
}));

vi.mock('../engine/routeConstraints', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../engine/routeConstraints')>()),
  buildStopOptions: vi.fn(() => engine.stopOptions),
}));

vi.mock('../engine/stitch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../engine/stitch')>();
  return {
    ...actual,
    stitchAndFindPath: vi.fn(async (...args: Parameters<typeof actual.stitchAndFindPath>) => {
      const result = await actual.stitchAndFindPath(...args);
      const { constraints } = args[1] as { constraints?: RouteConstraints };
      if (!result.ok || constraints?.riskPolicy === 'avoidConditional') return result;
      return { ...result, value: { ...result.value, riskComparison: engine.comparison } };
    }),
  };
});

const { buildStopOptions } = await import('../engine/routeConstraints');
const { stitchAndFindPath } = await import('../engine/stitch');

const v = (s: string) => s as Version;
const CHANNEL = 'stable-4.20';
const BASE = `/?channel=${CHANNEL}&arch=amd64&start=4.18.2&target=4.20.32`;

/** 4.18.2 -> 4.20.32 in one hop carrying a vSphere conditional risk, or in two clean hops through 4.19.41. */
function makeClient(): GraphClient {
  const versions = ['4.18.2', '4.19.40', '4.19.41', '4.20.32'];
  const graph = {
    version: 1,
    nodes: versions.map((version, i) => ({
      version,
      payload: `quay.io/openshift-release-dev/ocp-release@sha256:${i.toString().padStart(64, '0')}`,
      metadata: { url: `https://access.redhat.com/errata/TEST-${i}`, 'io.openshift.upgrades.graph.release.channels': CHANNEL },
    })),
    edges: [
      [0, 1],
      [0, 2],
      [2, 3],
    ],
    conditionalEdges: [
      {
        edges: [{ from: '4.18.2', to: '4.20.32' }],
        risks: [
          {
            url: 'https://issues.redhat.com/browse/TEST-1',
            name: 'VSphereRisk',
            message: 'vSphere clusters may fail to upgrade.',
            matchingRules: [{ type: 'PromQL', promql: { promql: 'vsphere_topology' } }],
          },
        ],
      },
    ],
  };
  const fetchImpl = fakeFetch(async (url) => {
    const channel = new URL(url).searchParams.get('channel');
    return fakeJsonResponse(channel === CHANNEL ? graph : { version: 1, nodes: [], edges: [], conditionalEdges: [] });
  });
  return new GraphClient({ storage: new FakeStorage(), fetchImpl });
}

const CLEAN_ROUTE: Path = {
  versions: [v('4.18.2'), v('4.19.41'), v('4.20.32')],
  hops: [
    { from: v('4.18.2'), to: v('4.19.41'), risks: [], sourceChannel: 'fast-4.20' },
    { from: v('4.19.41'), to: v('4.20.32'), risks: [], sourceChannel: CHANNEL },
  ],
  cost: { hops: 2, riskWeight: 0, tieBreak: 0 },
  riskSummary: [],
};

function renderedGroups(select: HTMLElement): [string, string[]][] {
  return [...select.querySelectorAll('optgroup')].map((g) => [g.label, [...g.querySelectorAll('option')].map((o) => o.textContent ?? '')]);
}

function urlParam(name: string): string | null {
  return new URLSearchParams(window.location.search).get(name);
}

async function renderAt(path: string) {
  window.history.pushState({}, '', path);
  render(<App graphClient={makeClient()} />);
  await screen.findByRole('list', { name: 'Upgrade path stops' });
}

beforeEach(() => {
  engine.stopOptions = [
    { version: v('4.20.5'), channel: 'fast-4.20' },
    { version: v('4.19.41'), channel: CHANNEL },
    { version: v('4.19.40'), channel: CHANNEL },
  ];
  engine.comparison = undefined;
  vi.mocked(buildStopOptions).mockClear();
  vi.mocked(stitchAndFindPath).mockClear();
});

afterEach(() => {
  cleanup();
  window.history.pushState({}, '', '/');
});

describe('route stops', () => {
  it('keeps Add stop disabled until both start and target are set', async () => {
    window.history.pushState({}, '', `/?channel=${CHANNEL}&arch=amd64&start=4.18.2`);
    render(<App graphClient={makeClient()} />);
    await waitFor(() => expect(within(screen.getByLabelText('Target version')).getByRole('option', { name: '4.20.32' })).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Add stop' })).toBeDisabled();

    fireEvent.change(screen.getByLabelText('Target version'), { target: { value: '4.20.32' } });
    expect(screen.getByRole('button', { name: 'Add stop' })).toBeEnabled();
  });

  it('lists stop options grouped by stream, newest first, naming where each is reachable when it is not the selected channel', async () => {
    await renderAt(BASE);
    fireEvent.click(screen.getByRole('button', { name: 'Add stop' }));

    const stop = screen.getByLabelText('Stop 1');
    expect(stop.id).toBe('stop-0');
    expect(renderedGroups(stop)).toEqual([
      ['4.20', ['4.20.5 · reachable on fast-4.20']],
      ['4.19', ['4.19.41', '4.19.40']],
    ]);
  });

  it('adds, edits and removes stops in order, and the route search honors them', async () => {
    await renderAt(BASE);

    fireEvent.click(screen.getByRole('button', { name: 'Add stop' }));
    fireEvent.change(screen.getByLabelText('Stop 1'), { target: { value: '4.19.41' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add stop' }));
    fireEvent.change(screen.getByLabelText('Stop 2'), { target: { value: '4.19.40' } });

    await waitFor(() => expect(urlParam('stops')).toBe('4.19.41,4.19.40'));
    expect(window.location.search).toContain('stops=4.19.41,4.19.40');
    // Stop 2's options honor stop 1, and stop 1's honor stop 2.
    expect(buildStopOptions).toHaveBeenCalledWith(expect.anything(), '4.18.2', '4.20.32', ['4.19.41'], 1);
    expect(buildStopOptions).toHaveBeenCalledWith(expect.anything(), '4.18.2', '4.20.32', ['4.19.40'], 0);
    await waitFor(() =>
      expect(stitchAndFindPath).toHaveBeenLastCalledWith(
        expect.anything(),
        expect.objectContaining({ constraints: { stops: ['4.19.41', '4.19.40'], riskPolicy: 'recommended' } }),
      ),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Remove stop 1' }));
    expect(screen.queryByLabelText('Stop 2')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Stop 1')).toHaveValue('4.19.40');
    await waitFor(() => expect(urlParam('stops')).toBe('4.19.40'));

    fireEvent.click(screen.getByRole('button', { name: 'Remove stop 1' }));
    expect(screen.queryByLabelText('Stop 1')).not.toBeInTheDocument();
    await waitFor(() => expect(urlParam('stops')).toBeNull());
  });

  it('restores stops and avoid=conditional from the link once discovery completes', async () => {
    await renderAt(`${BASE}&stops=4.19.41&avoid=conditional`);

    expect(screen.getByLabelText('Stop 1')).toHaveValue('4.19.41');
    expect(screen.getByLabelText('Avoid conditional risks')).toBeChecked();
    expect(stitchAndFindPath).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ constraints: { stops: ['4.19.41'], riskPolicy: 'avoidConditional' } }),
    );
    expect(urlParam('stops')).toBe('4.19.41');
    expect(urlParam('avoid')).toBe('conditional');
  });

  it('flags an unparseable restored stop inline and withholds the route and commands until it is removed', async () => {
    window.history.pushState({}, '', `${BASE}&stops=banana`);
    render(<App graphClient={makeClient()} />);

    const error = await screen.findByText(/"banana" is not a release/);
    expect(screen.getByLabelText('Stop 1')).toHaveValue('banana');
    expect(screen.getByLabelText('Stop 1')).toHaveAccessibleDescription(error.textContent ?? '');
    expect(screen.getByText(/Route withheld/)).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Commands' })).not.toBeInTheDocument();
    expect(urlParam('stops')).toBe('banana');

    fireEvent.click(screen.getByRole('button', { name: 'Remove stop 1' }));
    expect(await screen.findByRole('heading', { name: 'Commands' })).toBeInTheDocument();
  });

  it('flags a restored stop that is a release but no longer offered, and lets the operator replace it', async () => {
    engine.stopOptions = [{ version: v('4.19.41'), channel: CHANNEL }];
    window.history.pushState({}, '', `${BASE}&stops=4.19.40`);
    render(<App graphClient={makeClient()} />);

    expect(await screen.findByText(/4\.19\.40 is not on any route/)).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Commands' })).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Stop 1'), { target: { value: '4.19.41' } });
    expect(await screen.findByRole('heading', { name: 'Commands' })).toBeInTheDocument();
    expect(screen.queryByText(/is not on any route/)).not.toBeInTheDocument();
  });
});

describe('risk policy', () => {
  it('offers the lower-risk route and switches to it, checking Avoid conditional risks and updating the link', async () => {
    engine.comparison = { route: CLEAN_ROUTE, conditionalFree: true };
    await renderAt(BASE);

    const section = await screen.findByRole('region', { name: 'Lower-risk route' });
    expect(section).toHaveTextContent('no conditional risks');
    expect(section).toHaveTextContent('2 hops · no known risks');
    expect(section).toHaveTextContent('on fast-4.20 → stable-4.20');
    expect(within(section).getByRole('list')).toHaveTextContent('4.19.41');
    expect(screen.getByLabelText('Avoid conditional risks')).not.toBeChecked();

    fireEvent.click(within(section).getByRole('button', { name: 'Use lower-risk route' }));

    expect(screen.getByLabelText('Avoid conditional risks')).toBeChecked();
    await waitFor(() => expect(urlParam('avoid')).toBe('conditional'));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Lower-risk route' })).not.toBeInTheDocument());

    fireEvent.click(screen.getByLabelText('Avoid conditional risks'));
    await waitFor(() => expect(urlParam('avoid')).toBeNull());
  });

  it('says plainly when no lower-risk route exists for a route with conditional risks', async () => {
    engine.comparison = { route: undefined, conditionalFree: false };
    await renderAt(BASE);

    expect(await screen.findByText('No lower-risk route exists for this start, target and stops.')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Lower-risk route' })).not.toBeInTheDocument();
  });
});
