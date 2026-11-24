import type { EusGraphLookup } from '../design/eus';
import type { PathHop } from '../engine/types';
import type { Graph } from '../graph/types';
import { buildGraph } from './buildGraph';

/** A graph publishing exactly `hops`. */
export function graphOf(hops: readonly PathHop[]): Graph {
  const versions = [...new Set(hops.flatMap((hop) => [hop.from, hop.to]))];
  return buildGraph(versions, hops.map((hop) => [versions.indexOf(hop.from), versions.indexOf(hop.to)] as const));
}

/** Every eus channel publishes every hop of the route. */
export function eusPublishing(hops: readonly PathHop[]): EusGraphLookup {
  return () => ({ kind: 'loaded', graph: graphOf(hops) });
}
