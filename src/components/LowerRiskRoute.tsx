import { NO_MARKS, type RiskId } from '../engine/risks';
import type { RiskComparison } from '../engine/routeConstraints';
import type { Path } from '../engine/types';
import { channelSequence, hasConditionalRisk, routeFacts } from './routeFacts';

/**
 * Offers the `avoidConditional` counterpart to the recommended route when
 * the engine found one, or says plainly that none exists when the
 * recommended route carries conditional risks.
 */
export function LowerRiskRoute({
  primary,
  comparison,
  notApplicable,
  onUse,
}: {
  readonly primary: Path;
  readonly comparison: RiskComparison | undefined;
  readonly notApplicable: ReadonlySet<RiskId>;
  readonly onUse: () => void;
}) {
  if (!comparison) return null;
  const { route, conditionalFree } = comparison;

  if (!route) {
    if (!hasConditionalRisk(primary, notApplicable)) return null;
    return <p className="lower-risk lower-risk--none">No lower-risk route exists for this start, target and stops.</p>;
  }

  const channels = channelSequence(route);

  return (
    <section className="lower-risk" aria-label="Lower-risk route">
      <div className="lower-risk__head">
        <p className="lower-risk__title">{lowerRiskTitle(route, conditionalFree)}</p>
        <button type="button" className="copy-button" onClick={onUse}>
          Use lower-risk route
        </button>
      </div>
      <ol className="lower-risk__stops">
        {route.versions.map((version, i) => (
          <li key={i} className="mono">
            {version}
          </li>
        ))}
      </ol>
      <p className="lower-risk__meta">
        {routeFacts(route, notApplicable)}
        {channels.length > 0 && ` · on ${channels.join(' → ')}`}
      </p>
    </section>
  );
}

function lowerRiskTitle(route: Path, conditionalFree: boolean): string {
  if (!conditionalFree) return 'A lower-risk route exists';
  return hasConditionalRisk(route, NO_MARKS) ? 'A route with no unmarked conditional risks exists' : 'A route with no conditional risks exists';
}
