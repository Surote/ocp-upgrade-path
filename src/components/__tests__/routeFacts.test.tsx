import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { dedupeRisks } from '../../engine/risks';
import type { Path } from '../../engine/types';
import type { Risk, Version } from '../../graph/types';
import { LowerRiskRoute } from '../LowerRiskRoute';
import { RouteSummary } from '../RouteSummary';

afterEach(cleanup);

const v = (s: string) => s as Version;
const risk = (always: boolean): Risk => ({
  name: 'EtcdStorageVersion3Migration',
  url: 'https://issues.example/OCPBUGS-1',
  message: 'etcd',
  matchingRules: [always ? { type: 'Always' } : { type: 'PromQL', promql: 'up' }],
});

// The same risk is unconditional on the first hop's channel and conditional on the second's.
const hops = [
  { from: v('4.20.0'), to: v('4.21.0'), risks: [risk(true)], sourceChannel: 'stable-4.21' },
  { from: v('4.21.0'), to: v('4.22.0'), risks: [risk(false)], sourceChannel: 'stable-4.22' },
];
const PATH: Path = {
  versions: [v('4.20.0'), v('4.21.0'), v('4.22.0')],
  hops,
  cost: { hops: 2, riskWeight: 3, tieBreak: 0 },
  riskSummary: dedupeRisks(hops.map((h) => h.risks)),
};

describe('the conditional-free claim reads every hop', () => {
  it('does not call a route conditional-free when a later hop carries a conditional occurrence of an earlier unconditional risk', () => {
    render(<RouteSummary path={PATH} />);
    expect(screen.getByText(/2 hops/).textContent).toBe('2 hops · 1 distinct risk(s)');
  });

  it('says no lower-risk route exists rather than staying silent', () => {
    render(<LowerRiskRoute primary={PATH} comparison={{ route: undefined, conditionalFree: false }} onUse={() => {}} />);
    expect(screen.getByText(/No lower-risk route exists/)).toBeTruthy();
  });
});
