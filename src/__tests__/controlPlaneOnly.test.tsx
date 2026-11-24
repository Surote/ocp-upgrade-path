import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import App from '../App';
import { GraphClient } from '../graph/client';
import { fakeFetch, fakeJsonResponse } from '../test-utils/fakeFetch';
import { FakeStorage } from '../test-utils/fakeStorage';
import { loadFixture } from '../test-utils/fixtures';

interface RawGraph {
  readonly nodes: readonly { readonly version: string; readonly payload: string }[];
  readonly edges: readonly (readonly [number, number])[];
  readonly conditionalEdges: readonly { readonly edges: readonly { readonly from: string; readonly to: string }[]; readonly risks: readonly unknown[] }[];
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

const EUS_PAYLOAD = `quay.io/openshift-release-dev/ocp-release@sha256:${'e'.repeat(64)}`;

/** `raw` with 4.19.40 -> 4.20.32 published only under an Always risk, and 4.20.32 at another payload digest. */
function withAlwaysRiskOnArrival(raw: RawGraph): RawGraph {
  const bare = withoutEdge(raw, '4.19.40', '4.20.32');
  return {
    ...bare,
    nodes: bare.nodes.map((node) => (node.version === '4.20.32' ? { ...node, payload: EUS_PAYLOAD } : node)),
    conditionalEdges: [
      ...bare.conditionalEdges,
      {
        edges: [{ from: '4.19.40', to: '4.20.32' }],
        risks: [{ url: 'https://issues.redhat.com/browse/OCPBUGS-1', name: 'EusOnlyRisk', message: 'Only eus-4.20 says so.', matchingRules: [{ type: 'Always' }] }],
      },
    ],
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

/** What the page says about the main route: its commands, its facts line, and each hop's detail panel. */
async function mainRoute(): Promise<string[]> {
  const shown = [...(await commandLines()), document.querySelector('.route-summary__meta')?.textContent ?? ''];
  for (const n of [1, 2]) {
    fireEvent.click(screen.getByRole('button', { name: new RegExp(`^Hop ${n} of 2:`) }));
    shown.push(screen.getByRole('heading', { name: new RegExp(`^Hop ${n} of 2:`) }).closest('section')?.textContent ?? '');
  }
  shown.push(screen.getByRole('region', { name: 'Risk summary' }).textContent ?? '');
  return shown;
}

const leg = () => screen.getByRole('list', { name: 'Control Plane Only legs' }).children[0] as HTMLElement;

afterEach(() => {
  cleanup();
  window.history.pushState({}, '', '/');
});

describe('Control Plane Only guidance on a stable-4.20 route (4.18.50 -> 4.19.40 -> 4.20.32)', () => {
  it('pauses only after eus-4.20 confirms the paused hops, and lists those updates in the leg, leaving the main commands on stable-4.20', async () => {
    openRoute(STABLE_420);

    await waitFor(() => expect(leg()).toHaveTextContent('"paused":true'));
    expect(leg()).toHaveTextContent('oc adm upgrade channel eus-4.20 && oc patch mcp/worker');
    expect(within(leg()).getAllByText(/^oc adm upgrade --to 4\./).map((code) => code.textContent)).toEqual([
      'oc adm upgrade --to 4.19.40',
      'oc adm upgrade --to 4.20.32',
    ]);
    expect(await commandLines()).toEqual(['oc adm upgrade --to 4.19.40', 'oc adm upgrade --to 4.20.32']);
  });

  it('never changes the main route, its commands, facts, hop details or risk summary, when eus-4.20 resolves', async () => {
    openRoute('pending');
    const whileChecking = await mainRoute();
    cleanup();

    openRoute(withAlwaysRiskOnArrival(STABLE_420));
    await waitFor(() => expect(leg()).toHaveTextContent('"paused":true'));
    expect(await mainRoute()).toEqual(whileChecking);
  });

  it("lists each paused update with eus-4.20's own risks and payload, and names a risk stable-4.20 does not attach", async () => {
    openRoute(withAlwaysRiskOnArrival(STABLE_420));

    await waitFor(() => expect(leg()).toHaveTextContent('"paused":true'));
    const update = within(leg()).getByText('oc adm upgrade --to 4.20.32').closest('li') as HTMLElement;
    expect(within(update).getByText('EusOnlyRisk')).toBeTruthy();
    expect(update).toHaveTextContent(`oc adm upgrade --to-image=${EUS_PAYLOAD} --allow-explicit-upgrade`);
    expect(update).toHaveTextContent('eus-4.20 attaches EusOnlyRisk (Always) to 4.19.40 → 4.20.32, which stable-4.20 does not.');
    expect(leg()).toHaveTextContent(/replaces the main Commands script's updates from 4\.18\.50 to 4\.20\.32/);
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
