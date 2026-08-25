import type { Path } from '../engine/types';

/**
 * A plain-text accessible alternative to the SVG map (quality floor: "SVG
 * needs an accessible text alternative describing the path"), rendered
 * visibly above the map -- a real `<ol>` (not clipped/hidden), so it doubles
 * as a compact route header for every reader, not only assistive tech.
 */
export function RouteSummary({ path }: { readonly path: Path }) {
  const riskCount = path.riskSummary.length;
  return (
    <div className="route-summary">
      <ol aria-label="Upgrade path stops">
        {path.versions.map((version) => (
          <li key={version} className="mono">
            {version}
          </li>
        ))}
      </ol>
      <p className="route-summary__meta">
        {path.hops.length} hop{path.hops.length === 1 ? '' : 's'} · {riskCount === 0 ? 'no risks' : `${riskCount} distinct risk(s)`}
      </p>
    </div>
  );
}
