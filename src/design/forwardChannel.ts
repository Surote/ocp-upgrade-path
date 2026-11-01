import type { Stream } from '../engine/version';
import { formatChannelName } from './channels';

const FALLBACK_CLASSES = ['stable'] as const;

/**
 * Candidate channel names for reaching a stream while walking *forward*
 * from an anchor channel, most-preferred first -- plan.md §6 "Forward
 * channel preference": the anchor's own class first (`eus-4.20` walking
 * forward tries `eus-4.22` before anything else), then `stable` (EUS is
 * even-minor only -- design/eus.ts -- so `eus-4.21` never exists).
 *
 * This function only *names* candidates; it does not check existence.
 * Callers must use the first one that is real -- an unknown Cincinnati
 * channel returns HTTP 200 with an empty graph, not a 404 (plan.md §2).
 * Shared between the engine's forward stitcher (engine/stitch.ts) and the
 * UI's look-ahead target discovery (planner/lookaheadTargets.ts) so the two
 * never prefer a channel differently.
 */
export function candidateChannelsForStream(preferredClass: string, stream: Stream): readonly string[] {
  const classes = [preferredClass, ...FALLBACK_CLASSES.filter((cls) => cls !== preferredClass)];
  return classes.map((cls) => formatChannelName({ cls, ...stream }));
}
