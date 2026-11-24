import { z } from 'zod';
import { VERSION_PATTERN } from '../engine/version';

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
 * Both schemas check structure and the version grammar; graph/parse.ts is responsible for the
 * semantic checks (empty-graph detection, edge index bounds) and for minting the
 * branded NodeIndex/Version types from the validated primitives.
 */

// The parser's own grammar, so a graph that loads can always be sorted and
// grouped by stream.
const versionSchema = z.string().regex(VERSION_PATTERN, 'Not an X.Y.Z[-prerelease][+build] version.');

// Payloads and channel names are pasted unquoted into the copyable
// `oc adm upgrade` script (design/commands.ts), so both are held to characters
// a POSIX shell reads literally, and neither may open with `-` and be read by
// `oc` as a flag. Every pinned fixture already fits.
const payloadSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/, 'Not a release image pullspec (registry/repo@sha256:digest or :tag).');

const channelNameSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'Not a channel name.');
// The comma-separated wire list; graph/parse.ts splits it and trims the spaces.
const channelListSchema = z
  .string()
  .regex(/^\s*(?:[A-Za-z0-9][A-Za-z0-9._-]*)?\s*(?:,\s*(?:[A-Za-z0-9][A-Za-z0-9._-]*)?\s*)*$/, 'Not a comma-separated channel list.');

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
  from: versionSchema,
  to: versionSchema,
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
    'io.openshift.upgrades.graph.release.channels': channelListSchema.optional(),
  })
  // Other metadata keys exist on the wire (previous.remove_regex, manifestref)
  // but nothing downstream needs them -- ignored, not rejected.
  .loose();

const rawNodeSchema = z.object({
  version: versionSchema,
  payload: payloadSchema,
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
  edges: z.array(z.object({ from: versionSchema, to: versionSchema })),
  risks: z.array(trimmedRiskSchema),
});

const trimmedNodeSchema = z.object({
  version: versionSchema,
  payload: payloadSchema,
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
  channelNames: z.array(channelNameSchema),
});

export type TrimmedGraphJSON = z.infer<typeof trimmedGraphSchema>;
