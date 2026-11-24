import { type AvailableLeg, type CheckingLeg, type ControlPlaneOnlyLeg, type LegCheckpoint, legCheckpoints, type UnavailableLeg } from '../design/eus';
import { formatStream } from '../engine/version';
import { describeGraphError } from '../graph/errors';
import { CopyButton } from './CopyButton';

/**
 * Control Plane Only (formerly EUS-to-EUS) guidance for the route's actual
 * versions (plan.md §6 "The EUS advisory"). Cincinnati does not encode this,
 * so it is rendered as a separate block labelled as guidance. Red Hat
 * renamed the procedure; "EUS-to-EUS" stays in the heading as the name
 * operators still use.
 */
export function EusAdvisory({ legs }: { readonly legs: readonly ControlPlaneOnlyLeg[] }) {
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
            <LegBody leg={leg} n={i + 1} />
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

function LegBody({ leg, n }: { readonly leg: ControlPlaneOnlyLeg; readonly n: number }) {
  switch (leg.kind) {
    case 'available':
      return <AvailableLegSteps leg={leg} n={n} />;
    case 'checking':
      return <CheckingLegNote leg={leg} n={n} />;
    case 'unavailable':
      return <UnavailableLegNote leg={leg} n={n} />;
  }
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
        {legCheckpoints(leg).map((checkpoint) => {
          const text = checkpoint.commands.join('\n');
          return (
            <li key={checkpoint.kind}>
              <p className="cpo-checkpoint__when">{checkpoint.when}</p>
              <div className="command-line">
                <pre className="script-block cpo-leg-command">
                  <code>{text}</code>
                </pre>
                <CopyButton text={text} label={`Copy leg ${n} ${COPY_LABEL[checkpoint.kind]}`} />
              </div>
            </li>
          );
        })}
      </ol>
    </>
  );
}

function CheckingLegNote({ leg, n }: { readonly leg: CheckingLeg; readonly n: number }) {
  return (
    <>
      <h3>
        Leg {n}: {formatStream(leg.from)} → {formatStream(leg.to)} (checking {leg.eusChannel})
      </h3>
      <p className="panel__hint" aria-busy="true">
        Checking that {leg.eusChannel} publishes every update this leg takes with workers paused. Don't pause worker pools until
        this leg shows its pause steps.
      </p>
    </>
  );
}

function unavailableReason(leg: UnavailableLeg): string {
  const runsOn = `Red Hat's procedure switches the cluster to ${leg.eusChannel} before pausing workers`;
  const { reason } = leg;
  switch (reason.kind) {
    case 'notStable':
      return (
        `The update from ${reason.hop.from} to ${reason.hop.to} comes from ${reason.hop.sourceChannel ?? 'an unrecorded channel'}, and Red Hat ` +
        `offers a Control Plane Only update only after every update involved is available in a stable channel. Take this leg as a ` +
        `standard update, or plan it on ${leg.eusChannel} once these releases reach that channel.`
      );
    case 'notOnEus':
      return (
        `${runsOn}, and ${leg.eusChannel} does not publish the update from ${reason.hop.from} to ${reason.hop.to}. Take this leg as a ` +
        `standard update, or plan it on ${leg.eusChannel} once that update reaches the channel.`
      );
    case 'eusNotLoaded':
      return reason.error.kind === 'empty'
        ? `${runsOn}, and ${leg.eusChannel} has no releases yet: Red Hat usually rolls out EUS updates 45 to 90 days after GA. ` +
            'Take this leg as a standard update.'
        : `${runsOn}, and the planner could not load ${leg.eusChannel} to check that it publishes this leg's updates ` +
            `(${describeGraphError(reason.error)}). Take this leg as a standard update, or reload to check again.`;
  }
}

function UnavailableLegNote({ leg, n }: { readonly leg: UnavailableLeg; readonly n: number }) {
  return (
    <>
      <h3>
        Leg {n}: {formatStream(leg.from)} → {formatStream(leg.to)} (Control Plane Only update not available on this route)
      </h3>
      <p className="panel__hint">Don't pause worker pools for this leg. {unavailableReason(leg)}</p>
    </>
  );
}
