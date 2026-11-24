import { isWaived, riskClass, riskNameOf } from '../engine/risks';
import type { Risk } from '../graph/types';
import type { RiskApplicabilityViewModel } from '../planner/usePlanner';
import { CopyButton } from './CopyButton';

/**
 * One risk, rendered per plan.md §5: `Always` sorted first by the caller,
 * heavier weight, full message; `Conditional` shows its PromQL in a
 * collapsed, plain-monospace block with a copy button (its purpose is
 * pasting into the cluster's own Thanos/Prometheus, not reading on screen).
 *
 * Severity is never colour-only: the "Always"/"Conditional" word and a
 * distinct icon glyph both accompany the colour, so severity survives for a
 * screen-reader user and a colour-blind user alike.
 *
 * A conditional card lets the operator mark the risk as not applying to their
 * cluster. The card stays, de-emphasized, and says the claim is theirs: the
 * cluster-version operator, not this page, evaluates the PromQL.
 */
export function RiskCard({ risk, applicability }: { readonly risk: Risk; readonly applicability: RiskApplicabilityViewModel }) {
  const cls = riskClass(risk);
  const isAlways = cls === 'Always';
  const promqlRules = risk.matchingRules.filter((r) => r.type === 'PromQL');
  const marked = isWaived(risk, applicability.notApplicable);

  return (
    <li className={`risk-card risk-card--${isAlways ? 'always' : 'conditional'}${marked ? ' risk-card--marked' : ''}`}>
      <div className="risk-card__head">
        <span className="risk-badge" aria-hidden="true">
          {isAlways ? '▲' : '◆'}
        </span>
        <span className="risk-card__class">{isAlways ? 'Always' : 'Conditional'}</span>
        <span className="risk-card__name">{risk.name}</span>
      </div>
      {marked && (
        <p className="risk-card__marked-note">
          You marked this as not applicable. Check its PromQL against your cluster; the cluster-version operator evaluates it for real.
        </p>
      )}
      <p className="risk-card__message">{risk.message}</p>
      <div className="risk-card__footer">
        <a href={risk.url} target="_blank" rel="noopener noreferrer">
          View advisory ↗
        </a>
        {promqlRules.length > 0 && (
          <details className="risk-card__promql">
            <summary>Show PromQL{promqlRules.length > 1 ? ` (${promqlRules.length})` : ''}</summary>
            {promqlRules.map((rule, i) => (
              // biome-ignore lint: static list, order-stable, no id available
              <div className="promql-block" key={i}>
                <code className="promql-block__code">{rule.promql}</code>
                <CopyButton text={rule.promql} label="Copy query" />
              </div>
            ))}
          </details>
        )}
        {!isAlways && (
          <label className="checkbox-field risk-card__mark">
            <input
              type="checkbox"
              aria-label={`Doesn't apply to my cluster: ${risk.name}`}
              checked={marked}
              onChange={(e) => applicability.onChange(riskNameOf(risk), e.target.checked)}
            />
            Doesn't apply to my cluster
          </label>
        )}
      </div>
    </li>
  );
}
