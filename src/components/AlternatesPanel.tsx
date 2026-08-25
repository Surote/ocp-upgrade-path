import { laneClassName } from '../design/lanes';
import { parseVersion } from '../engine/version';
import type { Path } from '../engine/types';

/**
 * Up to two alternate routes, rendered clearly subordinate to the primary
 * (design brief) -- smaller, muted, non-interactive. `alternates` is empty
 * both when there genuinely are none *and* when the result was assembled
 * across multiple channels (a multi-graph stitch never computes them --
 * engine/stitch.ts's module doc explains why waypoint alternates don't
 * survive a real channel boundary). Those two empty cases must read
 * differently, so `multiGraph` decides which explanation to show rather
 * than leaving a bare empty area either way.
 */
export function AlternatesPanel({
  alternates,
  multiGraph,
  channelsUsed,
}: {
  readonly alternates: readonly Path[];
  readonly multiGraph: boolean;
  readonly channelsUsed: readonly string[];
}) {
  return (
    <section className="panel panel--alternates" aria-labelledby="alternates-heading">
      <h2 id="alternates-heading">Alternate routes</h2>
      {alternates.length === 0 ? (
        <p className="panel__hint">
          {multiGraph
            ? `Not computed: this path was assembled across multiple channels (${channelsUsed.join(', ')}). Waypoint alternates only apply within a single channel's graph.`
            : 'No alternate routes — the recommended path above is the only viable one found.'}
        </p>
      ) : (
        <ul className="alternates-list">
          {alternates.map((alt, i) => (
            // biome-ignore lint: alternates are order-stable, no better key than position
            <li className="alternate-route" key={i}>
              <p className="alternate-route__meta">
                Alternate {i + 1} · {alt.hops.length} hop{alt.hops.length === 1 ? '' : 's'} ·{' '}
                {alt.riskSummary.length === 0 ? 'no known risks' : `${alt.riskSummary.length} distinct risk(s)`}
              </p>
              <ol className="alternate-route__stops">
                {alt.versions.map((version) => (
                  <li key={version}>
                    <span className={`stop-dot ${laneClassName(parseVersion(version).minor)}`} aria-hidden="true" />
                    <span className="mono">{version}</span>
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
