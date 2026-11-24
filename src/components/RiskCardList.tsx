import { groupRisksByClass } from '../design/riskDisplay';
import type { Risk } from '../graph/types';
import type { RiskApplicabilityViewModel } from '../planner/usePlanner';
import { RiskCard } from './RiskCard';

/**
 * Renders a risk list grouped Always-first, Conditional-second (plan.md §5),
 * with a "deliberately clean" state when there are none -- a hop or path
 * with zero risk must read as verified-clean, not as an empty void.
 */
export function RiskCardList({
  risks,
  cleanLabel,
  applicability,
}: {
  readonly risks: readonly Risk[];
  readonly cleanLabel: string;
  readonly applicability: RiskApplicabilityViewModel;
}) {
  if (risks.length === 0) {
    return (
      <p className="risk-clean">
        <span className="risk-clean__icon" aria-hidden="true">
          ✓
        </span>
        {cleanLabel}
      </p>
    );
  }

  const { always, conditional } = groupRisksByClass(risks);

  return (
    <ul className="risk-card-list">
      {[...always, ...conditional].map((risk) => (
        <RiskCard key={`${risk.name}|${risk.url}`} risk={risk} applicability={applicability} />
      ))}
    </ul>
  );
}
