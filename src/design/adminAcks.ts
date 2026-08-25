import { parseVersion } from '../engine/version';
import type { Version } from '../graph/types';

/**
 * Pre-upgrade acknowledgements (plan.md §6 "Pre-upgrade acknowledgements
 * (admin-acks)"). Before a cluster crosses certain minors, an admin must
 * acknowledge pending Kubernetes API removals by patching the `admin-acks`
 * ConfigMap in `openshift-config`, or the CVO blocks the upgrade. Cincinnati
 * does not encode this at all -- like the EUS advisory, it is guidance this
 * tool adds on top of the graph, not something read off an edge.
 *
 * **Ack keys are never synthesised from a pattern.** They look like
 * `ack-4.<N-1>-<topic>-in-4.<N>`, but the topic segment is unpredictable
 * (`kube-1.27-api-removals`, `gateway-api-management`, `boot-image-opt-out`,
 * ...) and some destination minors need more than one key (4.19 needs two)
 * while others need none at all (4.17, 4.18, 4.21, per the destination
 * version's own "Preparing to update a cluster" docs, checked individually).
 * This table is the *only* source of truth -- every entry was read off the
 * real docs page for that destination minor, not derived from a rule.
 */
const ACK_KEYS: ReadonlyMap<number, readonly string[]> = new Map([
  [14, ['ack-4.13-kube-1.27-api-removals-in-4.14']],
  [16, ['ack-4.15-kube-1.29-api-removals-in-4.16']],
  [19, ['ack-4.18-gateway-api-management-in-4.19', 'ack-4.18-kube-1.32-api-removals-in-4.19']],
  [20, ['ack-4.19-admissionregistration-v1beta1-api-removals-in-4.20']],
  [22, ['ack-4.21-boot-image-opt-out-in-4.22']],
]);

/**
 * KCS article ids for "Preparing to upgrade to OpenShift Container Platform
 * 4.N" -- verified titles, one per destination minor. `undefined` for a minor
 * with no verified id: `kcsLinkFor` below falls back to a KCS *search* rather
 * than guessing an article number, since access.redhat.com article ids are
 * not sequential or derivable from the minor.
 */
const KCS_ARTICLE_IDS: ReadonlyMap<number, string> = new Map([
  [9, '6329921'],
  [12, '6955381'],
  [13, '6958394'],
  [14, '6958395'],
  [16, '7031404'],
  [19, '7112216'],
  [20, '7130599'],
]);

/**
 * The ack keys documented for entering minor `minor`. Returns an empty array
 * both when the destination page was checked and genuinely lists none (4.17,
 * 4.18, 4.21) and when the minor has never been checked at all (anything not
 * in `ACK_KEYS`) -- deliberately: absence of a key on a docs page is not
 * proof that no acknowledgement is required for that minor, so both cases
 * must render identically as "none documented" rather than diverge into a
 * false "no acknowledgement required for this minor" for the unchecked case.
 * Callers must never build a key from a template -- this lookup is the only
 * legitimate source.
 */
export function adminAckKeysFor(minor: number): readonly string[] {
  return ACK_KEYS.get(minor) ?? [];
}

export interface KcsLink {
  readonly url: string;
  /** True when no verified article id exists and `url` is a KCS search instead of a direct article link. */
  readonly isSearch: boolean;
}

/**
 * The KCS article (or, absent a verified id, a KCS search) for "Preparing to
 * upgrade to OpenShift Container Platform 4.<minor>". Never guesses an
 * article id -- `access.redhat.com/articles/<id>` ids are opaque and not
 * derivable from the minor number.
 */
export function kcsLinkFor(minor: number): KcsLink {
  const id = KCS_ARTICLE_IDS.get(minor);
  if (id) {
    return { url: `https://access.redhat.com/articles/${id}`, isSearch: false };
  }
  // `+`-joined, matching the verified live URL form from plan.md §6 exactly
  // (`encodeURIComponent` would emit `%20` for the spaces instead, which is
  // equivalent per RFC 3986 but not what was actually checked to return 200).
  const query = `Preparing to upgrade to OpenShift Container Platform 4.${minor}`.split(' ').map(encodeURIComponent).join('+');
  return { url: `https://access.redhat.com/search/?q=${query}`, isSearch: true };
}

/**
 * Distinct minors a path enters, in traversal order, excluding the start
 * version's own minor -- plan.md §6: "Show an ack block for each minor the
 * path enters (a 4.18→4.22 path enters 4.19, 4.20, 4.21, 4.22)." A path that
 * never leaves its start minor (a pure patch-level bump) enters none.
 */
export function minorsEntered(versions: readonly Version[]): readonly number[] {
  if (versions.length === 0) return [];
  const startMinor = parseVersion(versions[0] as Version).minor;
  const seen = new Set<number>([startMinor]);
  const entered: number[] = [];
  for (const version of versions.slice(1)) {
    const minor = parseVersion(version).minor;
    if (!seen.has(minor)) {
      seen.add(minor);
      entered.push(minor);
    }
  }
  return entered;
}

/**
 * One `oc -n openshift-config patch cm admin-acks` command acknowledging
 * every key in `keys` at once -- a single ConfigMap `--patch` with one
 * `data` entry per key, merge-typed, matching the verbatim shape Red Hat's
 * own 4.20 docs show for a single key. Callers must never call this with an
 * empty `keys` array (guarded by the UI: only rendered when
 * `adminAckKeysFor` returned at least one key).
 */
export function buildAdminAckCommand(keys: readonly string[]): string {
  const data = keys.map((key) => `"${key}":"true"`).join(',');
  return `oc -n openshift-config patch cm admin-acks \\\n  --patch '{"data":{${data}}}' \\\n  --type=merge`;
}
