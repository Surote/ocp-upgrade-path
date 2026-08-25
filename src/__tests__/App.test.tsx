import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
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
    const unreachableOption = within(targetSelect).getByRole('option', { name: /4\.20\.99.*unavailable/ }) as HTMLOptionElement;
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
});
