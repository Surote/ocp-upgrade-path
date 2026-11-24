import { buildLegScript, controlPlaneOnlyLegs } from '../design/eus';
import { formatStream } from '../engine/version';
import type { Version } from '../graph/types';
import { CopyButton } from './CopyButton';

/**
 * Control Plane Only (formerly EUS-to-EUS) guidance for the route's actual
 * versions (plan.md §6 "The EUS advisory"). Cincinnati does not encode this,
 * so it is rendered as a separate block labelled as guidance. Red Hat
 * renamed the procedure; "EUS-to-EUS" stays in the heading as the name
 * operators still use.
 */
export function EusAdvisory({ versions }: { readonly versions: readonly Version[] }) {
  const legs = controlPlaneOnlyLegs(versions);
  if (legs.length === 0) return null;

  return (
    <aside className="panel panel--guidance" aria-labelledby="eus-heading">
      <p className="guidance-label">Guidance, not API-derived</p>
      <h2 id="eus-heading">Control Plane Only updates (EUS-to-EUS)</h2>
      <p className="panel__hint">
        Red Hat's Control Plane Only update moves a cluster between two even-numbered minors with only a single reboot of
        worker nodes. It covers one such step, so this route takes {legs.length === 1 ? 'one leg' : `${legs.length} legs`}.
        Unpause after each leg and let workers finish updating before the next: if pools are not unpaused, the cluster is not
        permitted to update to any future minor version. Keep each pause short, since a paused pool doesn't receive the rotated{' '}
        <code>kube-apiserver-to-kubelet-signer</code> CA certificate. Patch any custom worker pools the same way.
      </p>
      <ol className="cpo-leg-list" aria-label="Control Plane Only legs">
        {legs.map((leg, i) => {
          const script = buildLegScript(leg);
          return (
            <li key={leg.pauseAt}>
              <h3>
                Leg {i + 1}: {formatStream(leg.from)} → {formatStream(leg.to)} (pause workers before {formatStream(leg.via)},
                unpause at {formatStream(leg.to)})
              </h3>
              <div className="command-line">
                <pre className="script-block cpo-leg-command">
                  <code>{script}</code>
                </pre>
                <CopyButton text={script} label={`Copy leg ${i + 1} commands`} />
              </div>
              <p className="panel__hint">
                <a href={leg.docsUrl} target="_blank" rel="noopener noreferrer">
                  Red Hat docs: Control Plane Only update to {formatStream(leg.to)} ↗
                </a>
              </p>
            </li>
          );
        })}
      </ol>
    </aside>
  );
}
