import { type AvailableLeg, controlPlaneOnlyLegs, type LegCheckpoint, legCheckpoints, type UnavailableLeg } from '../design/eus';
import { formatStream } from '../engine/version';
import type { PathHop } from '../engine/types';
import { CopyButton } from './CopyButton';

/**
 * Control Plane Only (formerly EUS-to-EUS) guidance for the route's actual
 * versions (plan.md §6 "The EUS advisory"). Cincinnati does not encode this,
 * so it is rendered as a separate block labelled as guidance. Red Hat
 * renamed the procedure; "EUS-to-EUS" stays in the heading as the name
 * operators still use.
 */
export function EusAdvisory({ hops }: { readonly hops: readonly PathHop[] }) {
  const legs = controlPlaneOnlyLegs(hops);
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
        {legs.map((leg, i) => (
          <li key={formatStream(leg.from)}>
            {leg.kind === 'available' ? <AvailableLegSteps leg={leg} n={i + 1} /> : <UnavailableLegNote leg={leg} n={i + 1} />}
            <p className="panel__hint">
              <a href={leg.docsUrl} target="_blank" rel="noopener noreferrer">
                Red Hat docs: Control Plane Only update to {formatStream(leg.to)} ↗
              </a>
            </p>
          </li>
        ))}
      </ol>
    </aside>
  );
}

const COPY_LABEL: Record<LegCheckpoint['kind'], string> = {
  pause: 'pause',
  unpause: 'unpause',
  waitForPools: 'pool check',
};

function AvailableLegSteps({ leg, n }: { readonly leg: AvailableLeg; readonly n: number }) {
  return (
    <>
      <h3>
        Leg {n}: {formatStream(leg.from)} → {formatStream(leg.to)} (pause workers before {formatStream(leg.via)}, unpause at{' '}
        {formatStream(leg.to)})
      </h3>
      <ol className="cpo-checkpoints">
        {legCheckpoints(leg).map((checkpoint) => (
          <li key={checkpoint.kind}>
            <p className="cpo-checkpoint__when">{checkpoint.when}</p>
            <div className="command-line">
              <pre className="script-block cpo-leg-command">
                <code>{checkpoint.command}</code>
              </pre>
              <CopyButton text={checkpoint.command} label={`Copy leg ${n} ${COPY_LABEL[checkpoint.kind]}`} />
            </div>
          </li>
        ))}
      </ol>
    </>
  );
}

function UnavailableLegNote({ leg, n }: { readonly leg: UnavailableLeg; readonly n: number }) {
  const { from, to, sourceChannel } = leg.blockingHop;
  return (
    <>
      <h3>
        Leg {n}: {formatStream(leg.from)} → {formatStream(leg.to)} (Control Plane Only update not available on this route)
      </h3>
      <p className="panel__hint">
        Keep worker pools unpaused for this leg: the update from {from} to {to} comes from {sourceChannel ?? 'an unrecorded channel'}, and Red
        Hat offers a Control Plane Only update only after every update involved is available in a stable channel. Update through{' '}
        {formatStream(leg.via)} as a standard update, or plan this leg on eus-{formatStream(leg.to)} once its releases reach it.
      </p>
    </>
  );
}
