import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import App from '../App';
import { GraphClient } from '../graph/client';
import { fakeFetch, fakeJsonResponse } from '../test-utils/fakeFetch';
import { FakeStorage } from '../test-utils/fakeStorage';

const CHANNEL = 'stable-4.20';
const BASE = `/?channel=${CHANNEL}&arch=amd64&start=4.18.2&target=4.20.32`;
const MARK = "Doesn't apply to my cluster: VSphereRisk";
const NOTE = 'You marked this as not applicable. Check its PromQL against your cluster; the cluster-version operator evaluates it for real.';

const vsphere = {
  url: 'https://issues.redhat.com/browse/TEST-1',
  name: 'VSphereRisk',
  message: 'vSphere clusters may fail to upgrade.',
  matchingRules: [{ type: 'PromQL', promql: { promql: 'vsphere_topology' } }],
};
const etcd = {
  url: 'https://issues.redhat.com/browse/TEST-2',
  name: 'EtcdRisk',
  message: 'Every cluster restarts etcd twice.',
  matchingRules: [{ type: 'Always' }],
};

/**
 * 4.18.2 -> 4.20.32 in one hop carrying VSphereRisk, or two clean hops
 * through 4.19.41; 4.20.32 -> 4.20.40 carries EtcdRisk (Always) and VSphereRisk.
 */
function makeClient(): GraphClient {
  const versions = ['4.18.2', '4.19.41', '4.20.32', '4.20.40'];
  const graph = {
    version: 1,
    nodes: versions.map((version, i) => ({
      version,
      payload: `quay.io/openshift-release-dev/ocp-release@sha256:${i.toString().padStart(64, '0')}`,
      metadata: { url: `https://access.redhat.com/errata/TEST-${i}`, 'io.openshift.upgrades.graph.release.channels': CHANNEL },
    })),
    edges: [
      [0, 1],
      [1, 2],
    ],
    conditionalEdges: [
      { edges: [{ from: '4.18.2', to: '4.20.32' }], risks: [vsphere] },
      { edges: [{ from: '4.20.32', to: '4.20.40' }], risks: [etcd, vsphere] },
    ],
  };
  const fetchImpl = fakeFetch(async (url) => {
    const channel = new URL(url).searchParams.get('channel');
    return fakeJsonResponse(channel === CHANNEL ? graph : { version: 1, nodes: [], edges: [], conditionalEdges: [] });
  });
  return new GraphClient({ storage: new FakeStorage(), fetchImpl });
}

async function renderAt(path: string) {
  window.history.pushState({}, '', path);
  render(<App graphClient={makeClient()} />);
  await screen.findByRole('list', { name: 'Upgrade path stops' });
}

function stops(): string[] {
  return within(screen.getByRole('list', { name: 'Upgrade path stops' }))
    .getAllByRole('listitem')
    .map((li) => li.textContent ?? '');
}

function routeFacts(): string {
  return document.querySelector('.route-summary__meta')?.textContent ?? '';
}

function riskSummary(): HTMLElement {
  return screen.getByRole('region', { name: 'Risk summary' });
}

afterEach(() => {
  cleanup();
  window.history.pushState({}, '', '/');
});

describe('marking a conditional risk not applicable', () => {
  it('keeps the card, says whose claim it is, and drops the lower-risk offer it no longer earns', async () => {
    await renderAt(BASE);
    expect(screen.getByRole('region', { name: 'Lower-risk route' })).toBeInTheDocument();
    expect(routeFacts()).toBe('1 hop · 1 distinct risk');

    const box = within(riskSummary()).getByRole('checkbox', { name: MARK });
    fireEvent.click(box);
    expect(screen.queryByText('Searching for a path…')).not.toBeInTheDocument();

    await waitFor(() => expect(screen.queryByRole('region', { name: 'Lower-risk route' })).not.toBeInTheDocument());
    expect(box.isConnected && (box as HTMLInputElement).checked).toBe(true);
    expect(stops()).toEqual(['4.18.2', '4.20.32']);
    expect(within(riskSummary()).getByText('VSphereRisk')).toBeInTheDocument();
    expect(within(riskSummary()).getByText(NOTE)).toBeInTheDocument();
    expect(routeFacts()).toBe('1 hop · 1 distinct risk (1 marked not applicable) · no other conditional risks');
    expect(new URLSearchParams(window.location.search).get('na')).toBe('VSphereRisk');

    fireEvent.click(within(riskSummary()).getByRole('checkbox', { name: MARK }));
    expect(await screen.findByRole('region', { name: 'Lower-risk route' })).toBeInTheDocument();
    expect(within(riskSummary()).queryByText(NOTE)).not.toBeInTheDocument();
    expect(new URLSearchParams(window.location.search).get('na')).toBeNull();
  });

  it('shares one mark between the risk summary and the hop detail', async () => {
    await renderAt(BASE);
    fireEvent.click(screen.getByRole('button', { name: /^Hop 1 of 1/ }));
    const hop = screen.getByRole('region', { name: /^Hop 1 of 1/ });
    fireEvent.click(within(hop).getByRole('checkbox', { name: MARK }));
    await waitFor(() => expect(within(riskSummary()).getByRole('checkbox', { name: MARK })).toBeChecked());
    expect(within(hop).getByText(NOTE)).toBeInTheDocument();
  });

  it('offers no control on an Always card', async () => {
    await renderAt(`/?channel=${CHANNEL}&arch=amd64&start=4.20.32&target=4.20.40`);
    expect(within(riskSummary()).getByText('EtcdRisk')).toBeInTheDocument();
    expect(within(riskSummary()).getAllByRole('checkbox').map((box) => box.getAttribute('aria-label'))).toEqual([MARK]);
  });

  it('lets avoid=conditional take the risky shortcut once its risk is marked', async () => {
    await renderAt(`${BASE}&avoid=conditional`);
    expect(stops()).toEqual(['4.18.2', '4.19.41', '4.20.32']);
    cleanup();
    await renderAt(`${BASE}&avoid=conditional&na=VSphereRisk`);
    await waitFor(() => expect(stops()).toEqual(['4.18.2', '4.20.32']));
    expect(routeFacts()).toBe('1 hop · 1 distinct risk (1 marked not applicable) · no other conditional risks');
  });

  it('restores marks from the link and drops a name no risk carries, with a notice', async () => {
    await renderAt(`${BASE}&na=VSphereRisk,vsphererisk`);
    await waitFor(() => expect(within(riskSummary()).getByRole('checkbox', { name: MARK })).toBeChecked());
    expect(screen.getByText(/"vsphererisk"/)).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Lower-risk route' })).not.toBeInTheDocument();
    expect(new URLSearchParams(window.location.search).get('na')).toBe('VSphereRisk');
  });
});
