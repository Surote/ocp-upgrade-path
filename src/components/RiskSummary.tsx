import type { Risk } from '../graph/types';
import { RiskCardList } from './RiskCardList';

/**
 * The whole-path, deduplicated risk summary (plan.md §5): "what am I exposed
 * to overall". `riskSummary` is already deduplicated and Always-first by the
 * engine (`Path.riskSummary`, built by `dedupeRisks` in engine/risks.ts) --
 * this component only presents it.
 */
export function RiskSummary({ riskSummary }: { readonly riskSummary: readonly Risk[] }) {
  return (
    <section className="panel" aria-labelledby="risk-summary-heading">
      <h2 id="risk-summary-heading">Risk summary</h2>
      <p className="panel__hint">Every distinct risk on this path, deduplicated across hops. One risk can recur on many hops.</p>
      <RiskCardList risks={riskSummary} cleanLabel="No risks anywhere on this path." />
    </section>
  );
}
