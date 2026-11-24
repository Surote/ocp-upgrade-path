import { compareStreams, formatStream, type Stream } from '../engine/version';

export const LIFECYCLE_POLICY_URL = 'https://access.redhat.com/support/policy/updates/openshift';

/**
 * Streams older than this are labelled legacy. Per Red Hat's OpenShift life
 * cycle policy (LIFECYCLE_POLICY_URL, read via its product-life-cycles API
 * in Nov 2026), 4.18 is the oldest stream still inside a standard support
 * term: 4.17, 4.15 and 4.13 are end of life, and 4.16, 4.14 and 4.12 remain
 * only in add-on Extended Update Support terms. Raise this as streams age
 * out; the UI never states a support date, it points at the policy page.
 */
const OLDEST_CURRENT_STREAM: Stream = { major: 4, minor: 18 };

export function isLegacyStream(stream: Stream): boolean {
  return compareStreams(stream, OLDEST_CURRENT_STREAM) < 0;
}

/** The optgroup label for a stream's channels or releases, e.g. `4.14 · legacy`. */
export function streamLabel(stream: Stream): string {
  return isLegacyStream(stream) ? `${formatStream(stream)} · legacy` : formatStream(stream);
}
