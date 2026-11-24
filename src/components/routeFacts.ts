import { riskClass } from '../engine/risks';
import type { Path } from '../engine/types';

export function hasConditionalRisk(path: Path): boolean {
  return path.riskSummary.some((risk) => riskClass(risk) !== 'Always');
}

/**
 * "3 hops · 2 distinct risk(s) · no conditional risks". "No conditional
 * risks" is said only beside a count, because it is not "no known risks": an
 * `Always` risk can remain on a route with no conditional ones.
 */
export function routeFacts(path: Path): string {
  const riskCount = path.riskSummary.length;
  const facts = [`${path.hops.length} hop${path.hops.length === 1 ? '' : 's'}`];
  if (riskCount === 0) facts.push('no known risks');
  else {
    facts.push(`${riskCount} distinct risk(s)`);
    if (!hasConditionalRisk(path)) facts.push('no conditional risks');
  }
  return facts.join(' · ');
}
