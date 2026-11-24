import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import App from '../App';
import { GraphClient } from '../graph/client';
import { fakeFetch, fakeJsonResponse } from '../test-utils/fakeFetch';
import { FakeStorage } from '../test-utils/fakeStorage';

function rawGraph(versions: readonly string[], channelsCsv: string): unknown {
  return {
    version: 1,
    nodes: versions.map((version, i) => ({
      version,
      payload: `quay.io/openshift-release-dev/ocp-release@sha256:${i.toString().padStart(64, '0')}`,
      metadata: { url: `https://access.redhat.com/errata/TEST-${i}`, 'io.openshift.upgrades.graph.release.channels': channelsCsv },
    })),
    edges: versions.slice(1).map((_, i) => [i, i + 1]),
    conditionalEdges: [],
  };
}

const EMPTY = { nodes: [], edges: [], conditionalEdges: [] };

/** Like live Cincinnati: the seed's membership names nothing older than 4.18. */
const WORLD: Record<string, unknown> = {
  'stable-4.20': rawGraph(['4.19.0', '4.20.0'], 'stable-4.18,eus-4.18,stable-4.19,stable-4.20'),
  'stable-4.18': rawGraph(['4.18.1', '4.18.2'], 'stable-4.18,eus-4.18'),
  'stable-4.17': rawGraph(['4.16.1', '4.17.1'], 'stable-4.16,eus-4.16,stable-4.17'),
  'stable-4.16': rawGraph(['4.16.1'], 'stable-4.16'),
  'stable-4.15': rawGraph(['4.14.1', '4.15.1'], 'stable-4.13,fast-4.12,stable-4.14,eus-4.14,stable-4.15'),
  'eus-4.14': rawGraph(['4.12.0', '4.14.0', '4.14.1'], 'eus-4.12,stable-4.12,eus-4.14,stable-4.14'),
};

type Responder = (channel: string, attempt: number) => Response | undefined;

/** A client over `WORLD` that records every channel fetched; `override` can answer a fetch first. */
function worldClient(storage: Storage, override?: Responder) {
  const fetched: string[] = [];
  const fetchImpl = fakeFetch(async (url) => {
    const channel = new URL(url).searchParams.get('channel') ?? '';
    fetched.push(channel);
    const attempt = fetched.filter((c) => c === channel).length;
    return override?.(channel, attempt) ?? fakeJsonResponse(WORLD[channel] ?? EMPTY);
  });
  return { client: new GraphClient({ storage, fetchImpl }), fetched };
}

const unavailable = () => fakeJsonResponse({}, { ok: false, status: 503, statusText: 'Service Unavailable' });

function channelOptions(): string[] {
  return [...screen.getByLabelText('Channel').querySelectorAll('option')].map((o) => o.textContent ?? '').filter((t) => !t.startsWith('Select'));
}

function channelGroupLabels(): string[] {
  return [...screen.getByLabelText('Channel').querySelectorAll('optgroup')].map((g) => g.label);
}

afterEach(() => {
  cleanup();
  window.history.pushState({}, '', '/');
});

describe('Backward channel discovery', () => {
  it('grows the channel list down to 4.14 after the seed, though the seed names nothing older than 4.18', async () => {
    const { client } = worldClient(new FakeStorage());
    render(<App graphClient={client} />);

    await waitFor(() => expect(channelOptions()).toContain('eus-4.14'));
    expect(channelOptions()).toEqual(
      expect.arrayContaining(['stable-4.20', 'eus-4.18', 'stable-4.17', 'stable-4.16', 'eus-4.16', 'stable-4.15', 'stable-4.14', 'eus-4.14']),
    );
    // Membership of a 4.15 graph names 4.12/4.13 channels; the list stops at the 4.14 floor.
    expect(channelOptions()).not.toContain('stable-4.13');
    expect(channelOptions()).not.toContain('fast-4.12');
  });

  it('labels the optgroups of legacy streams and leaves current ones plain', async () => {
    const { client } = worldClient(new FakeStorage());
    render(<App graphClient={client} />);

    await waitFor(() => expect(channelGroupLabels()).toContain('4.14 · legacy'));
    expect(channelGroupLabels()).toEqual(['4.20', '4.19', '4.18', '4.17 · legacy', '4.16 · legacy', '4.15 · legacy', '4.14 · legacy']);
  });

  it('retries a failed probe, and an empty probe adds nothing', async () => {
    const { client, fetched } = worldClient(new FakeStorage(), (channel, attempt) =>
      channel === 'stable-4.15' && attempt === 1 ? unavailable() : undefined,
    );
    render(<App graphClient={client} />);

    await waitFor(() => expect(channelOptions()).toContain('eus-4.14'));
    expect(fetched.filter((c) => c === 'stable-4.15')).toHaveLength(2);
    expect(fetched).toContain('fast-4.17');
    expect(channelOptions()).not.toContain('fast-4.17');
  });

  it('restores discovered names on reload without probing again', async () => {
    const storage = new FakeStorage();
    const first = worldClient(storage);
    render(<App graphClient={first.client} />);
    await waitFor(() => expect(channelOptions()).toContain('eus-4.14'));
    // Let the sweep's remaining probes settle so the reload starts from its final cache.
    await waitFor(() => expect(first.fetched).toContain('candidate-4.14'));
    cleanup();

    const second = worldClient(storage);
    second.client.invalidateAll(); // graphs refetch; only the names cache should carry over
    render(<App graphClient={second.client} />);

    await waitFor(() => expect(channelOptions()).toContain('stable-4.20'));
    expect(channelOptions()).toEqual(expect.arrayContaining(['stable-4.17', 'eus-4.16', 'stable-4.14', 'eus-4.14']));
    expect(second.fetched).toEqual(['stable-4.20']);
  });

  it('probes a channel whose fetch failed again on the next load, but not one that came back empty', async () => {
    const storage = new FakeStorage();
    const failing: Responder = (channel) => (channel === 'stable-4.15' ? unavailable() : undefined);
    const first = worldClient(storage, failing);
    render(<App graphClient={first.client} />);
    await waitFor(() => expect(first.fetched).toContain('candidate-4.14'));
    cleanup();

    const second = worldClient(storage, failing);
    second.client.invalidateAll();
    render(<App graphClient={second.client} />);

    await waitFor(() => expect(second.fetched).toContain('stable-4.15'));
    expect(second.fetched).not.toContain('fast-4.17');
  });
});

describe('Legacy start notice', () => {
  async function renderAt(query: string) {
    window.history.pushState({}, '', query);
    const { client } = worldClient(new FakeStorage());
    render(<App graphClient={client} />);
    await waitFor(() => expect(within(screen.getByLabelText('Start version')).getAllByRole('option').length).toBeGreaterThan(1));
  }

  it('says a 4.14 start is a legacy release and links the lifecycle policy', async () => {
    await renderAt('/?channel=eus-4.14&arch=amd64&start=4.14.0');

    const note = await screen.findByText(/4\.14 is a legacy release/);
    const link = within(note).getByRole('link', { name: /lifecycle policy/ });
    expect(link).toHaveAttribute('href', 'https://access.redhat.com/support/policy/updates/openshift');
  });

  it('treats a 4.12 start inside a 4.14 graph the same way', async () => {
    await renderAt('/?channel=eus-4.14&arch=amd64&start=4.12.0');

    expect(await screen.findByText(/4\.12 is a legacy release/)).toBeInTheDocument();
  });

  it('shows nothing for a 4.18 start', async () => {
    await renderAt('/?channel=stable-4.18&arch=amd64&start=4.18.1');

    expect(screen.getByLabelText('Start version')).toHaveValue('4.18.1');
    expect(screen.queryByText(/legacy release/)).not.toBeInTheDocument();
  });
});
