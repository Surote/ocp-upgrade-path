import { type AvailableLeg, type CheckingLeg, type ControlPlaneOnlyLeg, type LegCheckpoint, type LegStep, type LegUpdate, legSteps, type UnavailableLeg } from '../design/eus';
import { formatStream } from '../engine/version';
import { describeGraphError } from '../graph/errors';
import type { RiskApplicabilityViewModel } from '../planner/usePlanner';
import { CopyButton } from './CopyButton';
import { RiskCardList } from './RiskCardList';

/**
 * Control Plane Only (formerly EUS-to-EUS) guidance for the route's actual
 * versions (plan.md §6 "The EUS advisory"). Cincinnati does not encode this,
 * so it is rendered as a separate block labelled as guidance. Red Hat
 * renamed the procedure; "EUS-to-EUS" stays in the heading as the name
 * operators still use.
 */
export function EusAdvisory({
  legs,
  applicability,
}: {
  readonly legs: readonly ControlPlaneOnlyLeg[];
  readonly applicability: RiskApplicabilityViewModel;
}) {
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
            <LegBody leg={leg} n={i + 1} applicability={applicability} />
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

function LegBody({ leg, n, applicability }: { readonly leg: ControlPlaneOnlyLeg; readonly n: number; readonly applicability: RiskApplicabilityViewModel }) {
  switch (leg.kind) {
    case 'available':
      return <AvailableLegSteps leg={leg} n={n} applicability={applicability} />;
    case 'checking':
      return <CheckingLegNote leg={leg} n={n} />;
    case 'unavailable':
      return <UnavailableLegNote leg={leg} n={n} />;
  }
}

const COPY_LABEL: Record<LegCheckpoint['kind'], string> = {
  checkPools: 'pool check before pausing',
  pause: 'pause',
  unpause: 'unpause',
  waitForPools: 'pool check',
  returnChannel: 'channel return',
};

function copyLabel(step: Exclude<LegStep, LegUpdate>, n: number): string {
  return step.kind === 'waitForUpdate' ? `Copy leg ${n} check that the update to ${step.hop.to} finished` : `Copy leg ${n} ${COPY_LABEL[step.kind]}`;
}

function stepKey(step: LegStep): string {
  return step.kind === 'update' || step.kind === 'waitForUpdate' ? `${step.kind} ${step.hop.to}` : step.kind;
}

function CommandBlock({ text, label, secondary = false }: { readonly text: string; readonly label: string; readonly secondary?: boolean }) {
  return (
    <div className={secondary ? 'command-line command-line--secondary' : 'command-line'}>
      <pre className="script-block cpo-leg-command">
        <code>{text}</code>
      </pre>
      <CopyButton text={text} label={label} />
    </div>
  );
}

function UpdateStep({
  step,
  eusChannel,
  n,
  applicability,
}: {
  readonly step: LegUpdate;
  readonly eusChannel: string;
  readonly n: number;
  readonly applicability: RiskApplicabilityViewModel;
}) {
  const { hop } = step;
  return (
    <>
      <p className="cpo-checkpoint__when">
        Update to {hop.to} on {eusChannel}, or by digest on a disconnected cluster
      </p>
      <CommandBlock text={step.upgradeTo} label={`Copy leg ${n} update to ${hop.to}`} />
      <CommandBlock text={step.upgradeToImage} label={`Copy leg ${n} update to ${hop.to} by digest`} secondary />
      {step.riskNotes.map((note) => (
        <p key={note} className="cpo-risk-note" role="note">
          {note}
        </p>
      ))}
      <RiskCardList risks={hop.risks} cleanLabel={`${eusChannel} attaches no known risks to this update.`} applicability={applicability} />
    </>
  );
}

function AvailableLegSteps({ leg, n, applicability }: { readonly leg: AvailableLeg; readonly n: number; readonly applicability: RiskApplicabilityViewModel }) {
  return (
    <>
      <h3>
        Leg {n}: {formatStream(leg.from)} → {formatStream(leg.to)} (pause workers before {formatStream(leg.via)}, unpause at{' '}
        {formatStream(leg.to)})
      </h3>
      <p className="panel__hint">
        Following this leg replaces the main Commands script's updates from {leg.pauseAt} to {leg.unpauseAt}. They run on{' '}
        {leg.eusChannel}, so each update below lists the risks {leg.eusChannel} attaches to it.
      </p>
      <ol className="cpo-checkpoints">
        {legSteps(leg).map((step) => (
          <li key={stepKey(step)}>
            {step.kind === 'update' ? (
              <UpdateStep step={step} eusChannel={leg.eusChannel} n={n} applicability={applicability} />
            ) : (
              <>
                <p className="cpo-checkpoint__when">{step.when}</p>
                <CommandBlock text={step.commands.join('\n')} label={copyLabel(step, n)} />
              </>
            )}
          </li>
        ))}
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
