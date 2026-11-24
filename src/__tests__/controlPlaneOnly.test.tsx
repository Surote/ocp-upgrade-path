import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import App from '../App';
import { GraphClient } from '../graph/client';
import { fakeFetch, fakeJsonResponse } from '../test-utils/fakeFetch';
import { FakeStorage } from '../test-utils/fakeStorage';
import { loadFixture } from '../test-utils/fixtures';

interface RawGraph {
  readonly nodes: readonly { readonly version: string }[];
  readonly edges: readonly (readonly [number, number])[];
  readonly conditionalEdges: readonly { readonly edges: readonly { readonly from: string; readonly to: string }[] }[];
}

const STABLE_420 = loadFixture('stable-4.20.json') as RawGraph;
const EMPTY = { version: 1, nodes: [], edges: [], conditionalEdges: [] };

function withoutEdge(raw: RawGraph, from: string, to: string): RawGraph {
  const at = (v: string) => raw.nodes.findIndex((n) => n.version === v);
  return {
    ...raw,
    edges: raw.edges.filter(([a, b]) => !(a === at(from) && b === at(to))),
    conditionalEdges: raw.conditionalEdges
      .map((group) => ({ ...group, edges: group.edges.filter((e) => !(e.from === from && e.to === to)) }))
      .filter((group) => group.edges.length > 0),
  };
}

/** `eus-4.20` answers with `eus`, or never answers when `eus` is 'pending'. */
function openRoute(eus: RawGraph | typeof EMPTY | 'pending') {
  const fetchImpl = fakeFetch(async (url) => {
    const channel = new URL(url).searchParams.get('channel');
    if (channel === 'stable-4.20') return fakeJsonResponse(STABLE_420);
    if (channel === 'eus-4.20') return eus === 'pending' ? new Promise<Response>(() => {}) : fakeJsonResponse(eus);
    return fakeJsonResponse(EMPTY);
  });
  window.history.pushState({}, '', '/?channel=stable-4.20&arch=amd64&start=4.18.50&target=4.20.32');
  render(<App graphClient={new GraphClient({ storage: new FakeStorage(), fetchImpl })} />);
}

async function commandLines(): Promise<string[]> {
  const section = await screen.findByRole('region', { name: 'Commands' });
  return (section.querySelector('code')?.textContent ?? '').split('\n');
}

const leg = () => screen.getByRole('list', { name: 'Control Plane Only legs' }).children[0] as HTMLElement;

afterEach(() => {
  cleanup();
  window.history.pushState({}, '', '/');
});

describe('Control Plane Only guidance on a stable-4.20 route (4.18.50 -> 4.19.40 -> 4.20.32)', () => {
  it('pauses only after eus-4.20 confirms the paused hops, and runs them on eus-4.20 in the commands too', async () => {
    openRoute(STABLE_420);

    await waitFor(() => expect(leg()).toHaveTextContent('"paused":true'));
    expect(leg()).toHaveTextContent('oc adm upgrade channel eus-4.20');
    const lines = await commandLines();
    expect(lines[0]).toMatch(/^oc adm upgrade channel eus-4\.20\b/);
    expect(lines.slice(1)).toEqual(['oc adm upgrade --to 4.19.40', 'oc adm upgrade --to 4.20.32']);
  });

  it('gives no pause steps when eus-4.20 does not publish a hop taken with workers paused', async () => {
    openRoute(withoutEdge(STABLE_420, '4.19.40', '4.20.32'));

    await waitFor(() => expect(leg()).toHaveTextContent(/eus-4\.20 does not publish the update from 4\.19\.40 to 4\.20\.32/));
    expect(leg().querySelector('h3')?.textContent).toBe('Leg 1: 4.18 → 4.20 (Control Plane Only update not available on this route)');
    expect(leg().textContent).not.toMatch(/"paused"/);
    expect(await commandLines()).toEqual(['oc adm upgrade --to 4.19.40', 'oc adm upgrade --to 4.20.32']);
  });

  it('gives no pause steps, and says why, when eus-4.20 has no releases', async () => {
    openRoute(EMPTY);

    await waitFor(() => expect(leg()).toHaveTextContent(/eus-4\.20 has no releases yet/));
    expect(leg().textContent).not.toMatch(/"paused"/);
  });

  it('shows the route at once and the leg as checking while eus-4.20 loads', async () => {
    openRoute('pending');

    expect(await commandLines()).toEqual(['oc adm upgrade --to 4.19.40', 'oc adm upgrade --to 4.20.32']);
    expect(leg().querySelector('h3')?.textContent).toBe('Leg 1: 4.18 → 4.20 (checking eus-4.20)');
    expect(leg().textContent).not.toMatch(/"paused"/);
  });
});
