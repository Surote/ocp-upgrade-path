import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import App from '../App';
import { GraphClient } from '../graph/client';
import { fakeFetch, fakeJsonResponse } from '../test-utils/fakeFetch';
import { FakeStorage } from '../test-utils/fakeStorage';

function rawGraphJson(versions: readonly string[], edges: ReadonlyArray<readonly [number, number]>, channelsCsv: string): unknown {
  return {
    version: 1,
    nodes: versions.map((version, i) => ({
      version,
      payload: `quay.io/openshift-release-dev/ocp-release@sha256:${i.toString().padStart(64, '0')}`,
      metadata: { url: `https://access.redhat.com/errata/TEST-${i}`, 'io.openshift.upgrades.graph.release.channels': channelsCsv },
    })),
    edges: edges.map(([a, b]) => [a, b]),
    conditionalEdges: [],
  };
}

function clientFor(graphs: Record<string, unknown>): GraphClient {
  const fetchImpl = fakeFetch(async (url) => {
    const channel = new URL(url).searchParams.get('channel') ?? '';
    return fakeJsonResponse(graphs[channel] ?? { nodes: [], edges: [], conditionalEdges: [] });
  });
  return new GraphClient({ storage: new FakeStorage(), fetchImpl });
}

/** Each `<optgroup>` label with its options' text, in rendered order. */
function renderedGroups(select: HTMLElement): [string, string[]][] {
  return [...select.querySelectorAll('optgroup')].map((g) => [g.label, [...g.querySelectorAll('option')].map((o) => o.textContent ?? '')]);
}

function makeClient(): GraphClient {
  // seed (stable-4.20) plus one demo channel with a reachable and an unreachable target.
  const seed = rawGraphJson(['4.19.0', '4.20.0'], [[0, 1]], 'stable-4.20,demo-4.21');
  const demo = rawGraphJson(['4.18.2', '4.19.40', '4.20.32', '4.20.99'], [[0, 1], [1, 2]], 'demo-4.21');

  const fetchImpl = fakeFetch(async (url) => {
    const u = new URL(url);
    const channel = u.searchParams.get('channel');
    if (channel === 'stable-4.20') return fakeJsonResponse(seed);
    if (channel === 'demo-4.21') return fakeJsonResponse(demo);
    return fakeJsonResponse({ nodes: [], edges: [], conditionalEdges: [] });
  });
  return new GraphClient({ storage: new FakeStorage(), fetchImpl });
}

afterEach(() => {
  cleanup();
  window.history.pushState({}, '', '/');
});

describe('App', () => {
  it('renders the cascading form and walks channel -> arch -> start -> target -> a real path result', async () => {
    const client = makeClient();
    render(<App graphClient={client} />);

    expect(screen.getByLabelText('Channel')).toBeInTheDocument();
    expect(screen.getByLabelText('Architecture')).toBeInTheDocument();
    expect(screen.getByLabelText('Start version')).toBeInTheDocument();
    expect(screen.getByLabelText('Target version')).toBeInTheDocument();

    // Wait for seed-and-expand discovery to populate the channel dropdown.
    await waitFor(() => expect(screen.getByRole('option', { name: 'demo-4.21' })).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText('Channel'), { target: { value: 'demo-4.21' } });

    await waitFor(() => expect(screen.getByRole('option', { name: '4.18.2' })).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText('Start version'), { target: { value: '4.18.2' } });

    const targetSelect = screen.getByLabelText('Target version');
    await waitFor(() => expect(within(targetSelect).getByRole('option', { name: '4.20.32' })).toBeInTheDocument());

    // The disconnected 4.20.99 is present but disabled, with a reason in its own text.
    const unreachableOption = within(targetSelect).getByRole('option', { name: '4.20.99 (not reachable)' }) as HTMLOptionElement;
    expect(unreachableOption.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText('Target version'), { target: { value: '4.20.32' } });

    await waitFor(() => expect(screen.getByText(/Graph fetched at/)).toBeInTheDocument());

    // Named explicitly: the admin-acks guidance panel (new, unrelated feature)
    // now also renders `<ul>` lists on this page, so a bare role query is
    // ambiguous -- RouteSummary's own accessible name disambiguates it.
    const list = await screen.findByRole('list', { name: 'Upgrade path stops' });
    expect(list).toHaveTextContent('4.18.2');
    expect(list).toHaveTextContent('4.19.40');
    expect(list).toHaveTextContent('4.20.32');
  });

  it('lists look-ahead 5.x targets above in-channel 4.22.x targets, one group per stream, newest first', async () => {
    window.history.pushState({}, '', '/?channel=stable-4.22&arch=amd64&start=4.22.1');
    const membership = 'stable-4.21,fast-4.22,stable-4.22,fast-5.0';
    const client = clientFor({
      'stable-4.20': rawGraphJson(['4.20.0'], [], 'stable-4.20,stable-4.21,stable-4.22'),
      'stable-4.22': rawGraphJson(['4.21.9', '4.22.1', '4.22.3', '4.22.10', '4.22.11'], [[0, 1], [1, 2], [2, 3]], membership),
      'fast-5.0': rawGraphJson(['4.22.10', '4.22.11', '5.0.0-rc.8', '5.0.0', '5.0.2'], [[0, 3], [3, 4]], 'fast-5.0'),
    });
    render(<App graphClient={client} />);

    const targetSelect = screen.getByLabelText('Target version');
    await waitFor(() => expect(within(targetSelect).getByRole('option', { name: /5\.0\.2/ })).toBeInTheDocument());

    expect(renderedGroups(targetSelect)).toEqual([
      ['5.0', ['5.0.2 · via fast-5.0 (class change)', '5.0.0 · via fast-5.0 (class change)']],
      ['4.22', ['4.22.11 (not reachable)', '4.22.10', '4.22.3']],
    ]);
    expect(renderedGroups(screen.getByLabelText('Start version'))).toEqual([
      ['4.22', ['4.22.11', '4.22.10', '4.22.3', '4.22.1']],
      ['4.21', ['4.21.9']],
    ]);
    await waitFor(() =>
      expect(renderedGroups(screen.getByLabelText('Channel'))).toEqual([
        ['5.0', ['fast-5.0']],
        ['4.22', ['stable-4.22', 'fast-4.22']],
        ['4.21', ['stable-4.21']],
        ['4.20', ['stable-4.20']],
      ]),
    );
  });

  it('keeps the AI caveat visible and shows hop/station detail only once something on the map is selected', async () => {
    render(<App graphClient={makeClient()} />);

    expect(screen.getByText('AI-generated.').closest('[role="note"]')).toHaveTextContent(/Verify with Red Hat docs before acting/);

    await waitFor(() => expect(screen.getByRole('option', { name: 'demo-4.21' })).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText('Channel'), { target: { value: 'demo-4.21' } });
    await waitFor(() => expect(screen.getByRole('option', { name: '4.18.2' })).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText('Start version'), { target: { value: '4.18.2' } });
    await waitFor(() => expect(within(screen.getByLabelText('Target version')).getByRole('option', { name: '4.20.32' })).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText('Target version'), { target: { value: '4.20.32' } });

    const hint = await screen.findByText(/Select a station or hop on the map/);
    expect(screen.queryByRole('heading', { name: /^Hop 1 of 2/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /^Station / })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /^Hop 1 of 2:/ }));
    expect(screen.getByRole('heading', { name: 'Hop 1 of 2: 4.18.2 → 4.19.40' })).toBeInTheDocument();
    expect(hint).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /^Station 4\.20\.32,/ }));
    expect(screen.getByRole('heading', { name: 'Station 4.20.32' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /^Hop 1 of 2:/ }));
    fireEvent.click(screen.getByRole('button', { name: /^Station 4\.20\.32,/ }));
    expect(screen.queryByRole('heading', { name: /^Hop 1 of 2/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /^Station / })).not.toBeInTheDocument();
    expect(screen.getByText(/Select a station or hop on the map/)).toBeInTheDocument();
  });
});

describe('Refresh', () => {
  it('withdraws the route while the refetch is in flight and offers no second Refresh to abort it', async () => {
    const demo = rawGraphJson(['4.18.2', '4.19.40', '4.20.32'], [[0, 1], [1, 2]], 'demo-4.21');
    const held: (() => void)[] = [];
    let hold = false;
    const fetchImpl = fakeFetch(async (url) => {
      const isDemo = new URL(url).searchParams.get('channel') === 'demo-4.21';
      if (isDemo && hold) await new Promise<void>((resolve) => held.push(resolve));
      return fakeJsonResponse(isDemo ? demo : { version: 1, nodes: [], edges: [], conditionalEdges: [] });
    });
    window.history.pushState({}, '', '/?channel=demo-4.21&arch=amd64&start=4.18.2&target=4.20.32');
    render(<App graphClient={new GraphClient({ storage: new FakeStorage(), fetchImpl })} />);
    await screen.findByRole('list', { name: 'Upgrade path stops' });

    hold = true;
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(screen.queryByRole('list', { name: 'Upgrade path stops' })).not.toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Refresh' })).not.toBeInTheDocument();
    expect(screen.getByText('Loading versions…')).toBeInTheDocument();

    hold = false;
    for (const resolve of held) resolve();
    expect(await screen.findByRole('list', { name: 'Upgrade path stops' })).toHaveTextContent('4.19.40');
  });
});
