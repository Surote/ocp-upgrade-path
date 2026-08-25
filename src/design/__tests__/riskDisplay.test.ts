import { describe, expect, it } from 'vitest';
import type { Risk } from '../../graph/types';
import { groupRisksByClass } from '../riskDisplay';

function alwaysRisk(name: string): Risk {
  return { url: `https://example.com/${name}`, name, message: 'always risk', matchingRules: [{ type: 'Always' }] };
}

function promqlRisk(name: string): Risk {
  return {
    url: `https://example.com/${name}`,
    name,
    message: 'conditional risk',
    matchingRules: [{ type: 'PromQL', promql: 'up == 1' }],
  };
}

describe('groupRisksByClass', () => {
  it('splits risks into always and conditional buckets, preserving order within each', () => {
    const risks = [promqlRisk('A'), alwaysRisk('B'), promqlRisk('C'), alwaysRisk('D')];
    const grouped = groupRisksByClass(risks);
    expect(grouped.always.map((r) => r.name)).toEqual(['B', 'D']);
    expect(grouped.conditional.map((r) => r.name)).toEqual(['A', 'C']);
  });

  it('returns empty buckets for an empty input', () => {
    expect(groupRisksByClass([])).toEqual({ always: [], conditional: [] });
  });

  it('a risk with both an Always and a PromQL rule is classified Always (matches engine/risks.ts riskClass)', () => {
    const mixed: Risk = {
      url: 'https://example.com/mixed',
      name: 'Mixed',
      message: 'm',
      matchingRules: [{ type: 'PromQL', promql: 'x' }, { type: 'Always' }],
    };
    const grouped = groupRisksByClass([mixed]);
    expect(grouped.always).toEqual([mixed]);
    expect(grouped.conditional).toEqual([]);
  });
});
