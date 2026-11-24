import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { dedupeRisks, NO_MARKS, type RiskName } from '../../engine/risks';
import type { Path } from '../../engine/types';
import type { Risk, Version } from '../../graph/types';
import { LowerRiskRoute } from '../LowerRiskRoute';
import { RouteSummary } from '../RouteSummary';
import { routeFacts } from '../routeFacts';

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
    render(<RouteSummary path={PATH} notApplicable={NO_MARKS} />);
    expect(screen.getByText(/2 hops/).textContent).toBe('2 hops · 1 distinct risk');
  });

  it('says no lower-risk route exists rather than staying silent', () => {
    render(<LowerRiskRoute primary={PATH} comparison={{ route: undefined, conditionalFree: false }} notApplicable={NO_MARKS} onUse={() => {}} />);
    expect(screen.getByText(/No lower-risk route exists/)).toBeTruthy();
  });
});

describe('claims about risks marked not applicable', () => {
  const conditional = (name: string): Risk => ({ name, url: `https://issues.example/${name}`, message: name, matchingRules: [{ type: 'PromQL', promql: 'up' }] });
  const path = (...perHop: Risk[][]): Path => ({
    versions: [v('4.20.0'), ...perHop.map((_, i) => v(`4.21.${i}`))],
    hops: perHop.map((risks, i) => ({ from: v(i === 0 ? '4.20.0' : `4.21.${i - 1}`), to: v(`4.21.${i}`), risks })),
    cost: { hops: perHop.length, riskWeight: 0, tieBreak: 0 },
    riskSummary: dedupeRisks(perHop),
  });
  const marks = (...names: string[]) => new Set(names as RiskName[]);

  it('keeps a marked risk in the count, names it as marked, and says no other conditional risks remain', () => {
    const vsphere = conditional('VSphereConfigCloudControllerCrash');
    expect(routeFacts(path([vsphere], [vsphere]), marks('VSphereConfigCloudControllerCrash'))).toBe(
      '2 hops · 1 distinct risk (1 marked not applicable) · no other conditional risks',
    );
  });

  it('makes no conditional-free claim while an unmarked conditional risk remains', () => {
    expect(routeFacts(path([conditional('A')], [conditional('B')]), marks('A'))).toBe('2 hops · 2 distinct risks (1 marked not applicable)');
  });

  it('does not count a risk as marked where it also fires unconditionally', () => {
    expect(routeFacts(PATH, marks('EtcdStorageVersion3Migration'))).toBe('2 hops · 1 distinct risk · no other conditional risks');
  });
});
