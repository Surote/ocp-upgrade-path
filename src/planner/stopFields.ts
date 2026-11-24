import type { ChannelSegment } from '../engine/lookahead';
import { buildStopOptions, type StopOption } from '../engine/routeConstraints';
import { resolveVersion } from '../graph/parse';
import type { Version } from '../graph/types';

/**
 * One stop's standing against the current selection:
 *  - `blank`: added but not chosen yet; not a constraint.
 *  - `awaitingEndpoints`: start or target isn't chosen, so there is no route
 *    to judge the stop against until the operator picks one.
 *  - `pending`: look-ahead discovery isn't settled, so the stop can't be
 *    judged yet (a permalink restores before discovery ends).
 *  - `invalid`: not a release in these channels, or not on any route that
 *    honors the other stops; the route is withheld until it is fixed.
 *  - `valid`: offered for its position, so the route search can pin it.
 */
export type StopCheck =
  | { readonly kind: 'blank' }
  | { readonly kind: 'awaitingEndpoints' }
  | { readonly kind: 'pending' }
  | { readonly kind: 'invalid'; readonly message: string }
  | { readonly kind: 'valid'; readonly version: Version };

export interface StopRow {
  readonly raw: string;
  readonly check: StopCheck;
  readonly options: readonly StopOption[];
}

export interface StopContext {
  /** The anchor segment first, then look-ahead: the same graphs the target dropdown and the route search use. */
  readonly segments: readonly ChannelSegment[];
  readonly start: Version | undefined;
  readonly target: Version | undefined;
  /** False while look-ahead discovery for the anchor on screen is still running. */
  readonly discovered: boolean;
}

function findRelease(segments: readonly ChannelSegment[], raw: string): Version | undefined {
  for (const segment of segments) {
    const version = resolveVersion(segment.graph, raw);
    if (version) return version;
  }
  return undefined;
}

/**
 * Judges every stop against its neighbours. Options for stop `i` honor every
 * other stop that names a real release, so editing one stop narrows the
 * options of the stops around it.
 */
export function checkStops(raws: readonly string[], context: StopContext): readonly StopRow[] {
  const { segments, start, target, discovered } = context;
  if (!start || !target || !discovered) {
    const waiting: StopCheck = !start || !target ? { kind: 'awaitingEndpoints' } : { kind: 'pending' };
    return raws.map((raw) => ({ raw, check: raw ? waiting : { kind: 'blank' }, options: [] }));
  }

  const releases = raws.map((raw) => (raw ? findRelease(segments, raw) : undefined));
  return raws.map((raw, i) => {
    const others = releases.filter((v, j): v is Version => j !== i && v !== undefined);
    const gap = releases.slice(0, i).filter((v) => v !== undefined).length;
    const options = buildStopOptions(segments, start, target, others, gap);
    if (!raw) return { raw, check: { kind: 'blank' }, options };

    const offered = options.find((o) => o.version === raw);
    if (offered) return { raw, check: { kind: 'valid', version: offered.version }, options };
    const message = releases[i]
      ? `${raw} is not on any route from ${start} to ${target} through the other stops. Remove it or pick another stop.`
      : `"${raw}" is not a release in the selected channel or the channels ahead of it. Remove it or pick another stop.`;
    return { raw, check: { kind: 'invalid', message }, options };
  });
}
