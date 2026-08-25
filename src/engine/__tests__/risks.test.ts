import { describe, expect, it } from 'vitest';
import type { ConditionalEdgeGroup, Risk, Version } from '../../graph/types';
import { loadFixture } from '../../test-utils/fixtures';
import { parseRawGraph } from '../../graph/parse';
import { dedupeRisks, riskClass, RiskIndex, riskWeight } from '../risks';

function v(s: string): Version {
  return s as Version;
}

function alwaysRisk(name: string): Risk {
  return { url: `https://example.test/${name}`, name, message: 'msg', matchingRules: [{ type: 'Always' }] };
}
function promqlRisk(name: string): Risk {
  return {
    url: `https://example.test/${name}`,
    name,
    message: 'msg',
    matchingRules: [{ type: 'PromQL', promql: 'up == 0' }],
  };
}

describe('riskClass / riskWeight', () => {
  it('classifies a risk with only an Always rule as Always', () => {
    expect(riskClass(alwaysRisk('R1'))).toBe('Always');
  });

  it('classifies a risk with only a PromQL rule as PromQL', () => {
    expect(riskClass(promqlRisk('R1'))).toBe('PromQL');
  });

  it('classifies a risk carrying both an Always and a PromQL rule as Always -- the unconditional rule dominates', () => {
    const mixed: Risk = {
      url: 'https://example.test/mixed',
      name: 'Mixed',
      message: 'msg',
      matchingRules: [{ type: 'PromQL', promql: 'up == 0' }, { type: 'Always' }],
    };
    expect(riskClass(mixed)).toBe('Always');
  });

  it('weighs Always risks double and PromQL risks single, per plan.md §4', () => {
    expect(riskWeight([alwaysRisk('A'), alwaysRisk('B'), promqlRisk('C')])).toBe(2 + 2 + 1);
    expect(riskWeight([])).toBe(0);
  });
});

describe('RiskIndex — real fixtures', () => {
  it('reports zero risk for an edge absent from every conditionalEdges group', () => {
    const parsed = parseRawGraph(loadFixture('stable-4.20.json'), { channel: 'stable-4.20', arch: 'amd64' });
    if (!parsed.ok) throw parsed.error;
    const index = new RiskIndex(parsed.value.conditionalEdges);
    // The verified path from plan.md §1: 0 risks on every edge.
    expect(index.risksFor(v('4.18.2'), v('4.18.49'))).toEqual([]);
    expect(index.weightFor(v('4.18.2'), v('4.18.49'))).toBe(0);
  });

  it('finds a real risky edge and its weight in stable-4.20', () => {
    const parsed = parseRawGraph(loadFixture('stable-4.20.json'), { channel: 'stable-4.20', arch: 'amd64' });
    if (!parsed.ok) throw parsed.error;
    const firstGroup = parsed.value.conditionalEdges[0];
    expect(firstGroup).toBeDefined();
    const firstEdge = firstGroup?.edges[0];
    expect(firstEdge).toBeDefined();
    if (!firstEdge) return;

    const index = new RiskIndex(parsed.value.conditionalEdges);
    const risks = index.risksFor(firstEdge.from, firstEdge.to);
    expect(risks.length).toBeGreaterThan(0);
    expect(index.weightFor(firstEdge.from, firstEdge.to)).toBe(riskWeight(risks));
  });

  it('confirms no conditionalEdges group in stable-4.20 shares an edge with another group (0 of 2422 edges)', () => {
    const parsed = parseRawGraph(loadFixture('stable-4.20.json'), { channel: 'stable-4.20', arch: 'amd64' });
    if (!parsed.ok) throw parsed.error;
    const seen = new Map<string, number>();
    for (const group of parsed.value.conditionalEdges) {
      for (const { from, to } of group.edges) {
        const key = `${from}→${to}`;
        seen.set(key, (seen.get(key) ?? 0) + 1);
      }
    }
    const duplicated = [...seen.values()].filter((count) => count > 1);
    expect(duplicated).toEqual([]);
  });
});

describe('RiskIndex — union across groups (synthetic, since real fixtures never exercise this)', () => {
  it('unions risks when the same edge appears in more than one conditionalEdges group', () => {
    const groups: ConditionalEdgeGroup[] = [
      { edges: [{ from: v('1.0.0'), to: v('2.0.0') }], risks: [alwaysRisk('FromGroupA')] },
      { edges: [{ from: v('1.0.0'), to: v('2.0.0') }], risks: [promqlRisk('FromGroupB')] },
    ];
    const index = new RiskIndex(groups);
    const risks = index.risksFor(v('1.0.0'), v('2.0.0'));
    expect(risks.map((r) => r.name).sort()).toEqual(['FromGroupA', 'FromGroupB']);
    expect(index.weightFor(v('1.0.0'), v('2.0.0'))).toBe(2 + 1);
  });

  it('does not double-count an identical risk (same name+url) repeated across groups for the same edge', () => {
    const groups: ConditionalEdgeGroup[] = [
      { edges: [{ from: v('1.0.0'), to: v('2.0.0') }], risks: [alwaysRisk('Shared')] },
      { edges: [{ from: v('1.0.0'), to: v('2.0.0') }], risks: [alwaysRisk('Shared')] },
    ];
    const index = new RiskIndex(groups);
    expect(index.risksFor(v('1.0.0'), v('2.0.0'))).toHaveLength(1);
    expect(index.weightFor(v('1.0.0'), v('2.0.0'))).toBe(2);
  });
});

describe('dedupeRisks', () => {
  it('deduplicates by name+url across hops, preserving first-seen order within a class', () => {
    const r1 = promqlRisk('P1');
    const r2 = alwaysRisk('A1');
    const r1Again = promqlRisk('P1');
    const deduped = dedupeRisks([[r1], [r2, r1Again]]);
    expect(deduped.map((r) => r.name)).toEqual(['A1', 'P1']); // Always sorts first, per plan.md §5
  });

  it('returns an empty summary for a path with no risks anywhere', () => {
    expect(dedupeRisks([[], []])).toEqual([]);
  });
});
