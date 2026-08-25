import { z } from 'zod';

/**
 * Structural validation of the two wire shapes this app ever parses:
 *
 * 1. `rawGraphResponseSchema` -- the live API response shape, exactly as
 *    Cincinnati sends it (nested `metadata`, `conditionalEdges[].edges[].from/to`
 *    as version strings, `matchingRules[].promql` nested one level as
 *    `{promql: {promql: string}}`).
 * 2. `trimmedGraphSchema` -- the shape this app persists to the localStorage
 *    cache tier (already flattened/trimmed -- see graph/types.ts `Graph`). A
 *    second schema is needed because localStorage is untrusted storage (another
 *    tab, a stale app version, or plain corruption can all put something
 *    unexpected there) and must be re-validated on read, but its shape is not
 *    the wire shape.
 *
 * Both schemas only check *structure*; graph/parse.ts is responsible for the
 * semantic checks (empty-graph detection, edge index bounds) and for minting the
 * branded NodeIndex/Version types from the validated primitives.
 */

const rawMatchingRuleSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('Always') }).strict(),
  z.object({
    type: z.literal('PromQL'),
    promql: z.object({ promql: z.string() }).strict(),
  }).strict(),
]);

const rawRiskSchema = z.object({
  url: z.string(),
  name: z.string(),
  message: z.string(),
  matchingRules: z.array(rawMatchingRuleSchema),
});

const rawConditionalEdgeRefSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
});

const rawConditionalEdgeGroupSchema = z.object({
  edges: z.array(rawConditionalEdgeRefSchema),
  risks: z.array(rawRiskSchema),
});

const rawNodeMetadataSchema = z
  .object({
    url: z.string().optional(),
    // Comma-separated channel names this release is published in, e.g.
    // "candidate-4.18,eus-4.18,fast-4.18,stable-4.18,...". Absent on no node
    // observed live, but not contractually guaranteed -- optional, and an
    // absent/empty value is treated as "member of no channels" at parse time,
    // never a validation failure (see graph/parse.ts).
    'io.openshift.upgrades.graph.release.channels': z.string().optional(),
  })
  // Other metadata keys exist on the wire (previous.remove_regex, manifestref)
  // but nothing downstream needs them -- ignored, not rejected.
  .loose();

const rawNodeSchema = z.object({
  version: z.string().min(1),
  payload: z.string().min(1),
  metadata: rawNodeMetadataSchema.optional(),
});

const rawEdgeSchema = z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()]);

export const rawGraphResponseSchema = z.object({
  version: z.number(),
  nodes: z.array(rawNodeSchema),
  edges: z.array(rawEdgeSchema),
  conditionalEdges: z.array(rawConditionalEdgeGroupSchema),
});

export type RawGraphResponse = z.infer<typeof rawGraphResponseSchema>;
export type RawConditionalEdgeGroup = RawGraphResponse['conditionalEdges'][number];
export type RawRisk = RawConditionalEdgeGroup['risks'][number];
export type RawMatchingRule = RawRisk['matchingRules'][number];

// --- Trimmed / persisted (localStorage) shape -------------------------------

const trimmedMatchingRuleSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('Always') }).strict(),
  z.object({ type: z.literal('PromQL'), promql: z.string() }).strict(),
]);

const trimmedRiskSchema = z.object({
  url: z.string(),
  name: z.string(),
  message: z.string(),
  matchingRules: z.array(trimmedMatchingRuleSchema),
});

const trimmedConditionalEdgeGroupSchema = z.object({
  edges: z.array(z.object({ from: z.string().min(1), to: z.string().min(1) })),
  risks: z.array(trimmedRiskSchema),
});

const trimmedNodeSchema = z.object({
  version: z.string().min(1),
  payload: z.string().min(1),
  errataUrl: z.string().optional(),
  // Required (not optional): its absence is exactly the signal that a cached
  // entry was written by the pre-channel-membership (Phase 1) shape -- see
  // graph/parse.ts `parseTrimmedGraph`. A stale entry in that older shape fails
  // this schema and is rejected cleanly as a cache miss, rather than being
  // parsed into a Graph silently missing channel data.
  channels: z.array(z.number().int().nonnegative()),
});

export const trimmedGraphSchema = z.object({
  nodes: z.array(trimmedNodeSchema),
  edges: z.array(z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()])),
  conditionalEdges: z.array(trimmedConditionalEdgeGroupSchema),
  // Required, for the same reason `channels` above is required on each node.
  channelNames: z.array(z.string()),
});

export type TrimmedGraphJSON = z.infer<typeof trimmedGraphSchema>;
