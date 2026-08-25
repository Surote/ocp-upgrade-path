import { parseVersion } from '../engine/version';
import type { Version } from '../graph/types';

/**
 * The first minor with an EUS channel. Verified against the live API: `eus-4.1`
 * through `eus-4.5` all return an empty graph, while `eus-4.6` has 52 nodes.
 * Parity alone is NOT sufficient -- 4.2 and 4.4 are even but predate EUS
 * entirely, and without this floor the advisory misfires on a 4.4 -> 4.6 plan.
 */
const FIRST_EUS_MINOR = 6;

/**
 * EUS minors are even-numbered AND at or above 4.6 (plan.md §6 "The EUS
 * advisory"). Verified exhaustively against the live graph API across 4.1-4.23:
 * every even minor from 4.6 to 4.22 has a populated `eus-4.N` channel, every
 * odd minor returns zero nodes, and every even minor below 4.6 returns zero
 * nodes.
 */
export function isEusMinor(minor: number): boolean {
  return minor % 2 === 0 && minor >= FIRST_EUS_MINOR;
}

export interface EusAdvisory {
  /** True when both start and target sit on EUS (even) minors and at least two minors are crossed -- the shape that needs a worker-pause plan (plan.md §6). */
  readonly applies: boolean;
  readonly startMinor: number;
  readonly targetMinor: number;
}

/**
 * Detects the EUS-to-EUS upgrade shape from the start/target versions alone.
 * Cincinnati does not encode this (plan.md §6) -- this is UI-side guidance,
 * not API-derived data, and is presented as such (EusAdvisory.tsx).
 */
export function evaluateEusAdvisory(start: Version, target: Version): EusAdvisory {
  const startMinor = parseVersion(start).minor;
  const targetMinor = parseVersion(target).minor;
  const applies = isEusMinor(startMinor) && isEusMinor(targetMinor) && targetMinor - startMinor >= 2;
  return { applies, startMinor, targetMinor };
}
