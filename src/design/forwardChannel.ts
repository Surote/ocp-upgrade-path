/**
 * Candidate channel names for reaching a given minor while walking *forward*
 * from an anchor channel, most-preferred first -- plan.md §6 "Forward channel
 * preference": prefer the anchor's own class (`eus-4.20` walking forward
 * tries `eus-4.22` before anything else), falling back to `stable` at that
 * minor only when the preferred class genuinely has no channel there (EUS
 * channels are even-minor only -- design/eus.ts -- so `eus-4.21` never
 * exists).
 *
 * This function only *names* candidates; it does not check existence.
 * Callers must probe each candidate in order (actually fetch it) and use the
 * first one that is real -- an unknown Cincinnati channel returns HTTP 200
 * with an empty graph, not a 404 (plan.md §2), so existence can only be
 * confirmed by content, never assumed from the name alone. Shared between
 * the engine's forward stitcher (engine/stitch.ts) and the UI's lazy
 * look-ahead target discovery (planner/lookaheadTargets.ts) so the two never
 * drift into naming a channel differently.
 */
export function candidateChannelsForMinor(preferredClass: string, minor: number): readonly string[] {
  const preferred = `${preferredClass}-4.${minor}`;
  if (preferredClass === 'stable') return [preferred];
  return [preferred, `stable-4.${minor}`];
}
