import { describe, expect, it } from 'vitest';
import { loadFixture } from '../../test-utils/fixtures';
import { parseRawGraph, parseTrimmedGraph, resolveVersion } from '../parse';
import { toStorable } from '../serialize';

const CTX = { channel: 'stable-4.20', arch: 'amd64' } as const;

describe('parseRawGraph — real fixtures', () => {
  it('parses the pinned stable-4.20 fixture (124 nodes / 2422 unconditional + 1175 conditional edges)', () => {
    const result = parseRawGraph(loadFixture('stable-4.20.json'), CTX);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.nodes).toHaveLength(124);
    expect(result.value.edges).toHaveLength(2422 + 1175);
    expect(result.value.conditionalEdges).toHaveLength(72);
  });

  it('carries errataUrl through when present', () => {
    const result = parseRawGraph(loadFixture('stable-4.20.json'), CTX);
    if (!result.ok) throw result.error;
    const node = result.value.nodes.find((n) => n.version === '4.18.5');
    expect(node?.errataUrl).toBe('https://access.redhat.com/errata/RHSA-2025:2705');
  });

  it('treats metadata.url as optional and absent nodes get undefined, not a crash', () => {
    const result = parseRawGraph(loadFixture('candidate-4.20.json'), { channel: 'candidate-4.20', arch: 'amd64' });
    if (!result.ok) throw result.error;
    const withoutUrl = result.value.nodes.filter((n) => n.errataUrl === undefined);
    // Verified live: 17/171 nodes in this captured graph have no metadata.url.
    expect(withoutUrl.length).toBe(17);
  });

  it('brands edges as index pairs that resolve within nodes[]', () => {
    const result = parseRawGraph(loadFixture('stable-4.21.json'), { channel: 'stable-4.21', arch: 'amd64' });
    if (!result.ok) throw result.error;
    const { nodes, edges } = result.value;
    for (const [from, to] of edges) {
      expect(from).toBeGreaterThanOrEqual(0);
      expect(from).toBeLessThan(nodes.length);
      expect(to).toBeGreaterThanOrEqual(0);
      expect(to).toBeLessThan(nodes.length);
    }
  });

  it('rejects a conditional edge naming a version that is not a node', () => {
    const result = parseRawGraph(
      {
        version: 1,
        nodes: [{ version: '1.0.0', payload: 'p' }],
        edges: [],
        conditionalEdges: [{ edges: [{ from: '1.0.0', to: '9.9.9' }], risks: [] }],
      },
      CTX,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('validation');
  });

  it('brands conditionalEdges as version strings, distinct from the index-addressed edges', () => {
    const result = parseRawGraph(loadFixture('stable-4.19.json'), { channel: 'stable-4.19', arch: 'amd64' });
    if (!result.ok) throw result.error;
    const versions = new Set(result.value.nodes.map((n) => n.version));
    for (const group of result.value.conditionalEdges) {
      for (const { from, to } of group.edges) {
        expect(versions.has(from)).toBe(true);
        expect(versions.has(to)).toBe(true);
      }
    }
  });

  it('splits Always vs PromQL matching rules correctly (36 Always / 202 PromQL in stable-4.20)', () => {
    const result = parseRawGraph(loadFixture('stable-4.20.json'), CTX);
    if (!result.ok) throw result.error;
    let always = 0;
    let promql = 0;
    for (const group of result.value.conditionalEdges) {
      for (const risk of group.risks) {
        for (const rule of risk.matchingRules) {
          if (rule.type === 'Always') always += 1;
          else promql += 1;
        }
      }
    }
    expect(always).toBe(36);
    expect(promql).toBe(202);
  });
});

describe('parseRawGraph — channel membership (plan.md §3 amendment)', () => {
  it('interns per-node channel membership against a per-graph channelNames table', () => {
    const result = parseRawGraph(loadFixture('stable-4.20.json'), CTX);
    if (!result.ok) throw result.error;
    const node = result.value.nodes.find((n) => n.version === '4.18.5');
    expect(node).toBeDefined();
    const names = (node?.channels ?? []).map((id) => result.value.channelNames[id]);
    expect(names).toEqual([
      'candidate-4.18',
      'eus-4.18',
      'fast-4.18',
      'stable-4.18',
      'candidate-4.19',
      'fast-4.19',
      'stable-4.19',
      'candidate-4.20',
      'eus-4.20',
      'fast-4.20',
      'stable-4.20',
    ]);
  });

  it('interns identically-named channels shared by multiple nodes to the same id', () => {
    const result = parseRawGraph(loadFixture('stable-4.20.json'), CTX);
    if (!result.ok) throw result.error;
    const a = result.value.nodes.find((n) => n.version === '4.18.2');
    const b = result.value.nodes.find((n) => n.version === '4.18.5');
    const idOf = (node: typeof a, name: string) => {
      const id = node?.channels.find((cid) => result.value.channelNames[cid] === name);
      return id;
    };
    expect(idOf(a, 'stable-4.18')).toBe(idOf(b, 'stable-4.18'));
    // The table itself has no duplicate entries.
    expect(new Set(result.value.channelNames).size).toBe(result.value.channelNames.length);
  });

  it('yields an empty channel list, not a failure, when metadata is absent entirely', () => {
    const result = parseRawGraph(
      { version: 1, nodes: [{ version: '1.0.0', payload: 'p' }], edges: [], conditionalEdges: [] },
      CTX,
    );
    if (!result.ok) throw result.error;
    expect(result.value.nodes[0]?.channels).toEqual([]);
    expect(result.value.channelNames).toEqual([]);
  });

  it('yields an empty channel list, not a failure, when the channels string is empty', () => {
    const result = parseRawGraph(
      {
        version: 1,
        nodes: [{ version: '1.0.0', payload: 'p', metadata: { 'io.openshift.upgrades.graph.release.channels': '' } }],
        edges: [],
        conditionalEdges: [],
      },
      CTX,
    );
    if (!result.ok) throw result.error;
    expect(result.value.nodes[0]?.channels).toEqual([]);
  });
});

describe('parseRawGraph — the HTTP-200-with-empty-arrays trap', () => {
  it('surfaces an empty graph as a distinct `empty` error, not a successful empty result', () => {
    const result = parseRawGraph(
      { version: 1, nodes: [], edges: [], conditionalEdges: [] },
      { channel: 'not-a-real-channel', arch: 'amd64' },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('empty');
    if (result.error.kind === 'empty') {
      expect(result.error.channel).toBe('not-a-real-channel');
      expect(result.error.arch).toBe('amd64');
    }
  });
});

describe('parseRawGraph — malformed/garbage payload rejection', () => {
  it.each([
    ['null', null],
    ['a bare string', 'not a graph'],
    ['a number', 42],
    ['an array', [1, 2, 3]],
    ['an unrelated object', { foo: 'bar' }],
    ['nodes as the wrong type', { version: 1, nodes: 'nope', edges: [], conditionalEdges: [] }],
    [
      'an edge that is not a [number, number] tuple',
      { version: 1, nodes: [{ version: '1.0.0', payload: 'p' }], edges: [['a', 'b']], conditionalEdges: [] },
    ],
    [
      'a matchingRule of an unrecognised type',
      {
        version: 1,
        nodes: [{ version: '1.0.0', payload: 'p' }],
        edges: [],
        conditionalEdges: [
          { edges: [{ from: '1.0.0', to: '1.0.0' }], risks: [{ url: 'x', name: 'x', message: 'x', matchingRules: [{ type: 'Sometimes' }] }] },
        ],
      },
    ],
  ])('rejects %s', (_label, input) => {
    const result = parseRawGraph(input, CTX);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('validation');
  });

  it('rejects an edge whose index is out of range for nodes[]', () => {
    const result = parseRawGraph(
      { version: 1, nodes: [{ version: '1.0.0', payload: 'p' }], edges: [[0, 5]], conditionalEdges: [] },
      CTX,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('validation');
  });
});

describe('trimmed-shape round-trip', () => {
  it('survives serialize -> JSON -> parseTrimmedGraph unchanged', () => {
    const parsed = parseRawGraph(loadFixture('stable-4.21.json'), { channel: 'stable-4.21', arch: 'amd64' });
    if (!parsed.ok) throw parsed.error;

    const roundTripped = JSON.parse(JSON.stringify(toStorable(parsed.value))) as unknown;
    const reparsed = parseTrimmedGraph(roundTripped);

    expect(reparsed.ok).toBe(true);
    if (!reparsed.ok) return;
    expect(reparsed.value).toEqual(parsed.value);
  });

  it('parseTrimmedGraph rejects corrupt cached data instead of crashing', () => {
    const result = parseTrimmedGraph({ nodes: [{ version: '1.0.0' }], edges: [], conditionalEdges: [] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('validation');
  });

  it('rejects a stale entry written in the pre-channel-membership (Phase 1) shape rather than parsing it into a broken graph', () => {
    // The exact shape LocalStorageGraphCache would have persisted before this
    // amendment: nodes without `channels`, and no top-level `channelNames`.
    const staleValue = {
      nodes: [{ version: '4.20.1', payload: 'quay.io/x@sha256:00' }],
      edges: [],
      conditionalEdges: [],
    };
    const result = parseTrimmedGraph(staleValue);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('validation');
  });
});

describe('resolveVersion — minting a Version from untrusted input (Phase 3 URL boundary)', () => {
  it('resolves a raw string that exactly matches a node in the graph', () => {
    const parsed = parseRawGraph(loadFixture('stable-4.20.json'), CTX);
    if (!parsed.ok) throw parsed.error;

    const resolved = resolveVersion(parsed.value, '4.18.5');
    expect(resolved).toBe('4.18.5');
  });

  it('returns undefined -- never a crash, never a fabricated brand -- for a version absent from the graph', () => {
    const parsed = parseRawGraph(loadFixture('stable-4.20.json'), CTX);
    if (!parsed.ok) throw parsed.error;

    expect(resolveVersion(parsed.value, '9.9.9')).toBeUndefined();
  });

  it('returns undefined for garbage input (empty string, whitespace, unrelated text)', () => {
    const parsed = parseRawGraph(loadFixture('stable-4.20.json'), CTX);
    if (!parsed.ok) throw parsed.error;

    expect(resolveVersion(parsed.value, '')).toBeUndefined();
    expect(resolveVersion(parsed.value, '   ')).toBeUndefined();
    expect(resolveVersion(parsed.value, '<script>alert(1)</script>')).toBeUndefined();
  });

  it('is case-sensitive and does not fuzzy-match a near-miss version string', () => {
    const parsed = parseRawGraph(loadFixture('stable-4.20.json'), CTX);
    if (!parsed.ok) throw parsed.error;

    expect(resolveVersion(parsed.value, '4.18.05')).toBeUndefined();
    expect(resolveVersion(parsed.value, '4.18.5 ')).toBeUndefined();
  });
});
