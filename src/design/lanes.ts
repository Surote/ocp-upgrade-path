import { parseVersion } from '../engine/version';
import type { Version } from '../graph/types';

/**
 * The transit-map signature (design brief, Phase 4): each minor version gets
 * its own lane hue, deterministically. `LANE_COUNT` restrained hues live as
 * CSS custom properties (`--lane-0` .. `--lane-N`, see index.css) in the
 * indigo -> teal -> violet range -- warm hues are reserved exclusively for
 * risk severity (design/riskDisplay.ts), never assigned to a lane.
 *
 * Deliberately `minor % LANE_COUNT`, not a hash: OpenShift minors are small,
 * consecutive integers in practice (17, 18, 19, 20, 21, ...), and a plain
 * modulus keeps adjacent minors visually distinct (18%6=0, 19%6=1, 20%6=2,
 * 21%6=3, ...) while staying trivially deterministic across renders and
 * across the whole app -- the one thing the brief explicitly requires
 * ("the same minor is always the same colour").
 */
export const LANE_COUNT = 6;

/** Non-negative lane index in `[0, LANE_COUNT)` for a given minor version number. */
export function laneIndexForMinor(minor: number): number {
  const m = minor % LANE_COUNT;
  return m < 0 ? m + LANE_COUNT : m;
}

export function laneIndexForVersion(version: Version): number {
  return laneIndexForMinor(parseVersion(version).minor);
}

/** CSS class name for a minor's lane, e.g. `lane-2` -- pairs with `.lane-N` rules in index.css that set `--lane-color` per theme. */
export function laneClassName(minor: number): string {
  return `lane-${laneIndexForMinor(minor)}`;
}
