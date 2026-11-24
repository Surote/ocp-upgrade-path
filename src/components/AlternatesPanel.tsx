import type { Alternates } from '../engine/types';

/**
 * Up to two alternate routes, rendered clearly subordinate to the primary
 * (design brief) -- smaller, muted, non-interactive. When none are shown it
 * says why: none exist, or they were not computed for this route.
 */
export function AlternatesPanel({
  alternates,
  channelsUsed,
}: {
  readonly alternates: Alternates;
  readonly channelsUsed: readonly string[];
}) {
  const paths = alternates.kind === 'computed' ? alternates.paths : [];
  return (
    <section className="panel" aria-labelledby="alternates-heading">
      <h2 id="alternates-heading">Alternate routes</h2>
      {paths.length === 0 ? (
        <p className="panel__hint">{emptyHint(alternates, channelsUsed)}</p>
      ) : (
        <ul className="alternates-list">
          {paths.map((alt, i) => (
            // biome-ignore lint: alternates are order-stable, no better key than position
            <li key={i}>
              <p className="alternate-route__meta">
                Alternate {i + 1} · {alt.hops.length} hop{alt.hops.length === 1 ? '' : 's'} ·{' '}
                {alt.riskSummary.length === 0 ? 'no known risks' : `${alt.riskSummary.length} distinct risk(s)`}
              </p>
              <ol className="alternate-route__stops">
                {alt.versions.map((version) => (
                  <li key={version} className="mono">
                    {version}
                  </li>
                ))}
              </ol>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function emptyHint(alternates: Alternates, channelsUsed: readonly string[]): string {
  if (alternates.kind === 'computed') return 'No alternate routes — the recommended path above is the only viable one found.';
  switch (alternates.reason) {
    case 'multiGraph':
      return `Not computed: this path was assembled across multiple channels (${channelsUsed.join(', ')}). Waypoint alternates only apply within a single channel's graph.`;
    case 'constrained':
      return 'Not computed: alternate routes ignore pinned stops and Avoid conditional risks, so they are shown only when neither is set.';
  }
}
