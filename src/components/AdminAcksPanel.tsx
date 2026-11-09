import { adminAckKeysFor, buildAdminAckCommand, kcsLinkFor, streamsEntered } from '../design/adminAcks';
import { formatStream } from '../engine/version';
import type { Path } from '../engine/types';
import { CopyButton } from './CopyButton';

/**
 * Pre-upgrade acknowledgements (plan.md §6 "Pre-upgrade acknowledgements
 * (admin-acks)"). Before a cluster crosses certain minors, the CVO blocks the
 * upgrade until an admin has patched the `admin-acks` ConfigMap to
 * acknowledge pending Kubernetes API removals. Cincinnati never encodes this
 * -- it is guidance this tool adds on top of the graph, exactly like the EUS
 * advisory, and is presented the same way: visually separate, explicitly
 * labelled as guidance rather than something read off an edge.
 *
 * One block per stream the path *enters* (`streamsEntered`), not per hop --
 * several hops can land within the same minor. Where no ack key is
 * documented for a minor, this must say "none documented -- confirm via the
 * KCS", never "no acknowledgement required": absence of a key on a docs page
 * is not proof that none exists (plan.md §6).
 */
export function AdminAcksPanel({ path }: { readonly path: Path }) {
  const streams = streamsEntered(path.versions);
  if (streams.length === 0) return null;

  return (
    <aside className="panel panel--guidance" aria-labelledby="admin-acks-heading">
      <p className="guidance-label">Guidance, not API-derived</p>
      <h2 id="admin-acks-heading">Pre-upgrade acknowledgements</h2>
      <p className="panel__hint">
        Cincinnati doesn't encode this: entering certain minors requires acknowledging pending Kubernetes API removals by
        patching the <code>admin-acks</code> ConfigMap, or the cluster-version operator blocks the upgrade. Checked per minor
        this path enters below.
      </p>
      <ul className="admin-acks-list" aria-label="Pre-upgrade acknowledgements by minor">
        {streams.map((stream) => {
          const keys = adminAckKeysFor(stream);
          const kcs = kcsLinkFor(stream);
          const name = formatStream(stream);
          return (
            <li key={name} className="admin-acks-item">
              <h3>Entering {name}</h3>
              {keys.length > 0 ? (
                <>
                  <p className="panel__hint">
                    {keys.length} ack key{keys.length === 1 ? '' : 's'} documented:
                  </p>
                  <ul className="chip-list">
                    {keys.map((key) => (
                      <li key={key} className="chip">
                        {key}
                      </li>
                    ))}
                  </ul>
                  <div className="command-line">
                    <pre className="script-block admin-acks-command">
                      <code>{buildAdminAckCommand(keys)}</code>
                    </pre>
                    <CopyButton text={buildAdminAckCommand(keys)} label="Copy patch command" />
                  </div>
                </>
              ) : (
                <p className="admin-acks-unknown" role="note">
                  None documented — confirm via the KCS article below before upgrading.
                </p>
              )}
              <p className="panel__hint">
                <a href={kcs.url} target="_blank" rel="noopener noreferrer">
                  KCS{kcs.isSearch ? ' search' : ''}: preparing to upgrade to {name} ↗
                </a>{' '}
                (subscriber content — a 403 here means it's access-gated, not broken)
              </p>
            </li>
          );
        })}
      </ul>
    </aside>
  );
}
