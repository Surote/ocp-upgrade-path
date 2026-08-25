import { riskClass } from '../engine/risks';
import type { Risk } from '../graph/types';

export interface GroupedRisks {
  readonly always: readonly Risk[];
  readonly conditional: readonly Risk[];
}

/**
 * Splits one hop's risks into `Always` and `Conditional` buckets for
 * presentation (plan.md §5): `Always` sorted first, heavier weight, full
 * message; `Conditional` with its PromQL collapsed behind a copy button.
 * Order within each bucket is preserved from the input (the risk index's
 * own encounter order -- see engine/risks.ts `RiskIndex`).
 */
export function groupRisksByClass(risks: readonly Risk[]): GroupedRisks {
  const always: Risk[] = [];
  const conditional: Risk[] = [];
  for (const risk of risks) {
    (riskClass(risk) === 'Always' ? always : conditional).push(risk);
  }
  return { always, conditional };
}
