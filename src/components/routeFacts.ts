import { isWaived, NO_MARKS, riskClass, type RiskName } from '../engine/risks';
import type { Path } from '../engine/types';

/**
 * Whether any hop carries a conditional occurrence that counts, so one the
 * operator marked not applicable doesn't. Reads every hop, not
 * `riskSummary`: the summary keeps one occurrence per risk, and the same
 * risk can be `Always` on one channel's edge and conditional on the next.
 */
export function hasConditionalRisk(path: Path, notApplicable: ReadonlySet<RiskName>): boolean {
  return path.hops.some((hop) => hop.risks.some((risk) => riskClass(risk) !== 'Always' && !isWaived(risk, notApplicable)));
}

/** Distinct risks every occurrence of which on `path` is a marked conditional one. */
function markedRiskCount(path: Path, notApplicable: ReadonlySet<RiskName>): number {
  const waived = new Set<string>();
  const counted = new Set<string>();
  for (const hop of path.hops) {
    for (const risk of hop.risks) (isWaived(risk, notApplicable) ? waived : counted).add(risk.name);
  }
  return [...waived].filter((name) => !counted.has(name)).length;
}

/**
 * "3 hops · 2 distinct risks · no conditional risks". "No conditional
 * risks" is said only beside a count, because it is not "no known risks": an
 * `Always` risk can remain on a route with no conditional ones. Marked risks
 * stay in the count and are named as marked, and once they are the only
 * conditional ones left the claim says "no other".
 */
export function routeFacts(path: Path, notApplicable: ReadonlySet<RiskName>): string {
  const riskCount = path.riskSummary.length;
  const facts = [`${path.hops.length} hop${path.hops.length === 1 ? '' : 's'}`];
  if (riskCount === 0) facts.push('no known risks');
  else {
    const marked = markedRiskCount(path, notApplicable);
    facts.push(`${riskCount} distinct risk${riskCount === 1 ? '' : 's'}${marked > 0 ? ` (${marked} marked not applicable)` : ''}`);
    if (!hasConditionalRisk(path, notApplicable)) {
      facts.push(hasConditionalRisk(path, NO_MARKS) ? 'no other conditional risks' : 'no conditional risks');
    }
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
