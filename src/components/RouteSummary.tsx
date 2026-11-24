import type { RiskId } from '../engine/risks';
import type { Path } from '../engine/types';
import { routeFacts } from './routeFacts';

/**
 * A plain-text accessible alternative to the SVG map (quality floor: "SVG
 * needs an accessible text alternative describing the path"), rendered
 * visibly above the map -- a real `<ol>` (not clipped/hidden), so it doubles
 * as a compact route header for every reader, not only assistive tech.
 */
export function RouteSummary({ path, notApplicable }: { readonly path: Path; readonly notApplicable: ReadonlySet<RiskId> }) {
  return (
    <div className="route-summary">
      <ol aria-label="Upgrade path stops">
        {path.versions.map((version, i) => (
          // A route can visit one release twice, so a visit is its position.
          <li key={i} className="mono">
            {version}
          </li>
        ))}
      </ol>
      <p className="route-summary__meta">
        {routeFacts(path, notApplicable)}
      </p>
    </div>
  );
}
