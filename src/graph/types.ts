/**
 * Domain types for the Cincinnati update graph, including the branded (nominal)
 * types that keep the API's two node-addressing schemes from being conflated.
 *
 * The hazard: `edges` in the raw API response is an array of integer *index*
 * pairs into `nodes[]` (`[[3, 17], ...]`), while `conditionalEdges[].edges` is an
 * array of *version string* pairs (`[{from: "4.18.22", to: "4.19.10"}, ...]`).
 * Both are primitives (number / string) structurally, so nothing in the type
 * system would stop a NodeIndex from being passed where a Version is expected --
 * unless the two are given distinct nominal types.
 *
 * `NodeIndex` and `Version` below are branded with a phantom `__brand` field that
 * exists only at the type level (the `&` intersection costs nothing at runtime --
 * the values are plain `number`/`string` on the wire and in memory). The only
 * functions permitted to fabricate a branded value from a raw primitive live in
 * graph/parse.ts (unexported), which is the sole validation boundary for both a
 * freshly fetched API response and a value read back out of the localStorage
 * cache. Everywhere else in the codebase can only ever receive an
 * already-validated, already-branded value -- it has no way to mint one from a
 * bare `string` or `number` on its own, so the two addressing schemes cannot be
 * mixed by accident.
 */
export type NodeIndex = number & { readonly __brand: 'NodeIndex' };
export type Version = string & { readonly __brand: 'Version' };

/** Architectures the Cincinnati graph endpoint accepts. */
export const ARCHES = ['amd64', 'arm64', 'ppc64le', 's390x', 'multi'] as const;
export type Arch = (typeof ARCHES)[number];

export function isArch(value: string): value is Arch {
  return (ARCHES as readonly string[]).includes(value);
}

/**
 * Every risk's matchingRules entry observed live is one of exactly these two
 * types (verified across 5 captured graphs / 762 risk instances). If Cincinnati
 * ever introduces a third type, validation fails loudly at the parse boundary
 * (see graph/schema.ts) rather than this codebase silently mis-categorizing an
 * unrecognised rule as "safe to ignore".
 */
export type MatchingRule =
  | Readonly<{ type: 'Always' }>
  | Readonly<{ type: 'PromQL'; promql: string }>;

export interface Risk {
  readonly url: string;
  readonly name: string;
  readonly message: string;
  readonly matchingRules: readonly MatchingRule[];
}

export interface ConditionalEdgeRef {
  readonly from: Version;
  readonly to: Version;
}

/** One `conditionalEdges[]` entry: a group of version-addressed edges that share the same set of risks. */
export interface ConditionalEdgeGroup {
  readonly edges: readonly ConditionalEdgeRef[];
  readonly risks: readonly Risk[];
}

export interface GraphNode {
  readonly version: Version;
  /** Release image pull spec, e.g. `quay.io/openshift-release-dev/ocp-release@sha256:...`. */
  readonly payload: string;
  /**
   * Errata URL, e.g. `https://access.redhat.com/errata/RHSA-2026:8448`. Present on
   * 100% of nodes observed live, but NOT contractually guaranteed by the schema --
   * confirmed absent on 17/171 nodes in a captured candidate-4.20 graph. Always
   * optional; callers must handle its absence.
   */
  readonly errataUrl?: string;
  /**
   * Which channels this release is published in, as indices into the owning
   * `Graph.channelNames` table -- interned rather than stored as raw strings
   * (source: node metadata `io.openshift.upgrades.graph.release.channels`, a
   * comma-separated string like `"candidate-4.18,eus-4.18,fast-4.18,..."`).
   * Interning measured at ~3 KB on a 219 KB trimmed graph, vs. ~14 KB for raw
   * per-node strings. Empty when the metadata field is absent or empty -- never
   * a failure. Feeds the node-detail panel (§6) and seed-and-expand channel
   * discovery (Q6), which has no other source for the channel list.
   */
  readonly channels: readonly number[];
}

/**
 * The graph shape this app actually uses. Already trimmed of the metadata
 * Cincinnati sends but nothing downstream needs (previous-version removal
 * regexes, manifest refs) -- trimming this at the parse boundary, rather than
 * as a separate step before caching, means there is only ever one Graph shape
 * in play, and it is exactly what gets persisted to the localStorage cache tier.
 */
export interface Graph {
  readonly nodes: readonly GraphNode[];
  /** Integer index pairs into `nodes`: `edges[i] = [fromIndex, toIndex]`. */
  readonly edges: readonly (readonly [NodeIndex, NodeIndex])[];
  readonly conditionalEdges: readonly ConditionalEdgeGroup[];
  /** Channel-name table that `GraphNode.channels` indexes into (per plan.md §3). */
  readonly channelNames: readonly string[];
}
