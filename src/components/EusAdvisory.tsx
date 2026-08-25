import { evaluateEusAdvisory } from '../design/eus';
import type { Version } from '../graph/types';

/**
 * The EUS-to-EUS worker-pause advisory (plan.md §6 "The EUS advisory").
 * Cincinnati does not encode this -- `evaluateEusAdvisory` is pure UI-side
 * detection from the start/target minors, not something read off the graph.
 * Rendered as a visually distinct block and explicitly labelled "guidance,
 * not something Cincinnati asserted", per the plan's own instruction.
 *
 * **Terminology.** Red Hat renamed this procedure: it is documented today as
 * a **"Control Plane Only update"**, not "EUS-to-EUS" -- the old doc path
 * (`.../updating_clusters/preparing-eus-eus-upgrade`) 404s. "EUS-to-EUS" is
 * kept as a recognisable alias in the heading, since that's still what
 * operators call it in conversation, but the link and the primary label use
 * Red Hat's current name.
 */
export function EusAdvisory({ start, target }: { readonly start: Version; readonly target: Version }) {
  const advisory = evaluateEusAdvisory(start, target);
  if (!advisory.applies) return null;

  const docsUrl = `https://docs.redhat.com/en/documentation/openshift_container_platform/4.${advisory.targetMinor}/html/updating_clusters/performing-a-cluster-update#control-plane-only-update`;

  return (
    <aside className="panel panel--guidance" aria-labelledby="eus-heading">
      <p className="guidance-label">Guidance, not API-derived</p>
      <h2 id="eus-heading">
        Control Plane Only update (EUS-to-EUS): 4.{advisory.startMinor} → 4.{advisory.targetMinor}
      </h2>
      <p>
        This crosses {advisory.targetMinor - advisory.startMinor} minors between two EUS (even-numbered) releases. Cincinnati's
        graph doesn't say so, but Red Hat recommends pausing worker <code>MachineConfigPool</code>s first, so nodes reboot
        once for the whole jump instead of once per hop.
      </p>
      <pre className="script-block">
        <code>{"oc patch mcp/worker --type merge --patch '{\"spec\":{\"paused\":true}}'"}</code>
      </pre>
      <p className="panel__hint">Unpause the pool only after every hop above has completed, and complete the whole sequence within 60 days.</p>
      <p>
        <a href={docsUrl} target="_blank" rel="noopener noreferrer">
          Red Hat docs: Control Plane Only update ↗
        </a>
      </p>
    </aside>
  );
}
