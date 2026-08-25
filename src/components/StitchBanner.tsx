import type { ClassFallback } from '../engine/types';

/**
 * Names which channels were stitched together, whenever more than one was
 * used, so the path stays auditable (plan.md §4/§6). Never shown for a
 * single-channel result.
 *
 * `classFallbacks` (plan.md §6 "Forward channel preference") names every
 * channel in that list that was a `stable` substitute for the anchor's own
 * class -- e.g. an `eus` anchor reaching an odd EUS minor. This is never
 * folded silently into the plain channel list above: moving an operator
 * from `eus` to `stable` changes their support posture, and requirement 5
 * is explicit that this must be said outright, not left for someone to
 * notice by comparing channel-name prefixes themselves.
 */
export function StitchBanner({
  channelsUsed,
  classFallbacks,
}: {
  readonly channelsUsed: readonly string[];
  readonly classFallbacks: readonly ClassFallback[];
}) {
  if (channelsUsed.length <= 1) return null;
  return (
    <div className="stitch-banner">
      <p>
        <strong>Assembled across channels:</strong> {channelsUsed.join(' → ')}
      </p>
      {classFallbacks.map((fb) => (
        <p key={fb.channel} className="stitch-banner__fallback" role="alert">
          <strong>Channel class change:</strong> {fb.channel} was used instead of a <span className="mono">{fb.requestedClass}</span>{' '}
          channel at that minor, because none exists there — this changes the cluster's support posture at that step, not just its
          version.
        </p>
      ))}
    </div>
  );
}
