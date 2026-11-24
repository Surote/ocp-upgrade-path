import type { ConditionalEdgeGroup, Graph, Risk, Version } from '../graph/types';

/**
 * One advisory: its `name` and `url` together, since Cincinnati can publish
 * two advisories under one name and has no separate identity field. The risk
 * summary dedupes by it, the operator marks it not applicable, and a
 * permalink's `na=` carries it as is. Spelled `name~url` with `%` and `~` in
 * the name escaped, so the first `~` always splits it and any URL is kept.
 */
export type RiskId = string & { readonly __brand: 'RiskId' };

export const NO_MARKS: ReadonlySet<RiskId> = new Set();

const ID_SEPARATOR = '~';

export function riskIdOf(risk: Pick<Risk, 'name' | 'url'>): RiskId {
  const name = risk.name.replace(/[%~]/g, (c) => (c === '%' ? '%25' : '%7E'));
  return `${name}${ID_SEPARATOR}${risk.url}` as RiskId;
}

/** The advisory a `name~url` value names, respelled canonically; `undefined` when it has no separator or no URL. */
export function parseRiskId(value: string): RiskId | undefined {
  const at = value.indexOf(ID_SEPARATOR);
  if (at < 0 || at === value.length - 1) return undefined;
  const name = value.slice(0, at).replace(/%(25|7E)/gi, (_, hex: string) => (hex === '25' ? '%' : '~'));
  return riskIdOf({ name, url: value.slice(at + 1) });
}

/**
 * Which weight class a risk counts as, per plan.md §4:
 *
 *   riskWeight(edge) = 2 · |Always risks| + 1 · |PromQL risks|
 *
 * counted per *risk* (not per matchingRule -- a single risk can carry several
 * rules). A risk carrying both an `Always` rule and a `PromQL` rule is
 * classified `Always`: the unconditional rule fires on every cluster taking
 * the edge regardless of whether the PromQL condition would also have
 * matched, so the risk's real-world exposure is "always", and weighting it as
 * merely conditional would understate it. No risk observed across the pinned
 * fixtures actually carries both rule types (see risks.test.ts), so this
 * decision is currently unexercised by real data -- documented here rather
 * than left as a silent default so it stays correct if Cincinnati ever ships
 * such a risk.
 */
export function riskClass(risk: Risk): 'Always' | 'PromQL' {
  return risk.matchingRules.some((rule) => rule.type === 'Always') ? 'Always' : 'PromQL';
}

/**
 * Whether the operator's mark takes this occurrence out of risk counting. An
 * `Always` occurrence fires on every cluster, so a mark never waives it.
 */
export function isWaived(risk: Risk, notApplicable: ReadonlySet<RiskId>): boolean {
  return notApplicable.has(riskIdOf(risk)) && riskClass(risk) === 'PromQL';
}

/** Every advisory some edge of `graphs` carries as a conditional risk: the advisories a mark can waive. */
export function conditionalRisks(graphs: readonly Graph[]): ReadonlyMap<RiskId, Risk> {
  const risks = new Map<RiskId, Risk>();
  for (const graph of graphs) {
    for (const group of graph.conditionalEdges) {
      for (const risk of group.risks) if (riskClass(risk) === 'PromQL') risks.set(riskIdOf(risk), risk);
    }
  }
  return risks;
}

/** Per plan.md §4: `2 · |Always risks| + 1 · |PromQL risks|`, counted per risk. */
export function riskWeight(risks: readonly Risk[]): number {
  let weight = 0;
  for (const risk of risks) {
    weight += riskClass(risk) === 'Always' ? 2 : 1;
  }
  return weight;
}

function edgeKey(from: Version, to: Version): string {
  // U+2192 (RIGHTWARDS ARROW) cannot appear in a Cincinnati version string
  // (validated against `X.Y.Z[-prerelease]` at the parse boundary), so this
  // is collision-free without needing a delimiter-escaping scheme.
  return `${from}→${to}`;
}

/**
 * Inverts `Graph.conditionalEdges` (many version-addressed edges sharing one
 * risk set, per group) into a per-edge lookup, so the path engine can ask "what
 * risks does this specific edge carry" in O(1) instead of scanning every group.
 *
 * An edge can appear in more than one group -- verified against `stable-4.20`
 * live data, where it does not currently happen (0 of 2422 edges are members
 * of more than one conditionalEdges group), but the schema does not guarantee
 * disjointness, so this does not assume it. When it does happen, the risk sets
 * are unioned (deduplicated by `name`+`url`, since Cincinnati doesn't hand out
 * a separate risk-identity field) rather than the second group silently
 * overwriting the first.
 */
export class RiskIndex {
  private readonly byEdge = new Map<string, Risk[]>();

  constructor(conditionalEdges: readonly ConditionalEdgeGroup[]) {
    for (const group of conditionalEdges) {
      for (const { from, to } of group.edges) {
        const key = edgeKey(from, to);
        const existing = this.byEdge.get(key);
        if (!existing) {
          this.byEdge.set(key, [...group.risks]);
          continue;
        }
        const seen = new Set(existing.map(riskIdOf));
        for (const risk of group.risks) {
          const id = riskIdOf(risk);
          if (!seen.has(id)) {
            seen.add(id);
            existing.push(risk);
          }
        }
      }
    }
  }

  /** The (possibly unioned, per the class doc) risk set for one directed edge. Empty if the edge carries no risk. */
  risksFor(from: Version, to: Version): readonly Risk[] {
    return this.byEdge.get(edgeKey(from, to)) ?? [];
  }

  weightFor(from: Version, to: Version): number {
    return riskWeight(this.risksFor(from, to));
  }
}

/**
 * Deduplicates risks across an entire path (by `name`+`url`) for the
 * whole-path summary described in plan.md §5 -- "what am I exposed to
 * overall", as distinct from the per-hop accordion ("where does it enter").
 * `Always`-classified risks sort first, per §5's presentation rule; order is
 * otherwise first-encountered-hop-wins. A risk two hops carry under
 * different rules keeps an `Always` occurrence, since that hop fires on
 * every cluster.
 */
export function dedupeRisks(risksPerHop: readonly (readonly Risk[])[]): readonly Risk[] {
  const byId = new Map<string, Risk>();
  for (const hopRisks of risksPerHop) {
    for (const risk of hopRisks) {
      const id = riskIdOf(risk);
      const kept = byId.get(id);
      if (!kept || (riskClass(kept) !== 'Always' && riskClass(risk) === 'Always')) byId.set(id, risk);
    }
  }
  return [...byId.values()].sort((a, b) => {
    const aAlways = riskClass(a) === 'Always';
    const bAlways = riskClass(b) === 'Always';
    if (aAlways === bAlways) return 0;
    return aAlways ? -1 : 1;
  });
}
