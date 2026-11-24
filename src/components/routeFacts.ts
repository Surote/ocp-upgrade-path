import { riskClass } from '../engine/risks';
import type { Path } from '../engine/types';

/**
 * Reads every hop, not `riskSummary`: the summary keeps one occurrence per
 * risk, and the same risk can be `Always` on one channel's edge and
 * conditional on the next.
 */
export function hasConditionalRisk(path: Path): boolean {
  return path.hops.some((hop) => hop.risks.some((risk) => riskClass(risk) !== 'Always'));
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

/**
 * The channels `path`'s hops are taken on, in route order, one entry per run,
 * so a return to an earlier channel shows. `from`, the channel the cluster
 * starts on, leads when given, matching the switches the commands emit.
 */
export function channelSequence(path: Path, from?: string): readonly string[] {
  const channels: string[] = from ? [from] : [];
  for (const hop of path.hops) {
    if (hop.sourceChannel && hop.sourceChannel !== channels.at(-1)) channels.push(hop.sourceChannel);
  }
  return channels;
}
