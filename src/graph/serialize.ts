import type { Graph } from './types';

/**
 * Plain-JSON mirror of Graph with the NodeIndex/Version brands erased. This is
 * exactly what gets `JSON.stringify`'d into the localStorage cache tier -- the
 * brands only ever existed at the type level, so nothing here changes shape.
 */
export interface StorableGraph {
  readonly nodes: ReadonlyArray<{
    readonly version: string;
    readonly payload: string;
    readonly errataUrl?: string;
    readonly channels: readonly number[];
  }>;
  readonly edges: ReadonlyArray<readonly [number, number]>;
  readonly conditionalEdges: ReadonlyArray<{
    readonly edges: ReadonlyArray<{ readonly from: string; readonly to: string }>;
    readonly risks: ReadonlyArray<{
      readonly url: string;
      readonly name: string;
      readonly message: string;
      readonly matchingRules: ReadonlyArray<
        Readonly<{ type: 'Always' }> | Readonly<{ type: 'PromQL'; promql: string }>
      >;
    }>;
  }>;
  readonly channelNames: readonly string[];
}

/**
 * Converts a Graph into the plain value the localStorage cache tier persists.
 * A branded NodeIndex/Version is structurally just a number/string at runtime,
 * so this is a type-level erasure, not a data transformation. Reading a value
 * back out of storage always goes through `parseTrimmedGraph` (graph/parse.ts),
 * which re-validates and re-mints the brands rather than trusting this shape --
 * so this function is not, itself, part of the trust boundary.
 */
export function toStorable(graph: Graph): StorableGraph {
  return graph;
}
