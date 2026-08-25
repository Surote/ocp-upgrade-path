import { err, ok, type Result } from '../lib/result';
import type { GraphError } from './errors';
import {
  rawGraphResponseSchema,
  trimmedGraphSchema,
  type RawConditionalEdgeGroup,
  type RawMatchingRule,
  type RawRisk,
} from './schema';
import type { z } from 'zod';
import type {
  ConditionalEdgeGroup,
  Graph,
  GraphNode,
  MatchingRule,
  NodeIndex,
  Risk,
  Version,
} from './types';

const CHANNELS_METADATA_KEY = 'io.openshift.upgrades.graph.release.channels';

/**
 * Interns each node's comma-separated channel-membership string against a
 * shared per-graph name table, per plan.md §3. Splitting/trimming happens here
 * (the single place both parse entry points funnel through); an absent or
 * empty metadata field yields an empty channel list for that node, never a
 * failure -- channel membership is enrichment, not a structural requirement.
 */
function internChannels(
  channelsFields: readonly (string | undefined)[],
): { channelNames: string[]; perNodeChannels: number[][] } {
  const channelNames: string[] = [];
  const indexOf = new Map<string, number>();
  const perNodeChannels: number[][] = [];

  for (const field of channelsFields) {
    const names = field
      ? field
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s.length > 0)
      : [];
    const ids: number[] = [];
    for (const name of names) {
      let id = indexOf.get(name);
      if (id === undefined) {
        id = channelNames.length;
        indexOf.set(name, id);
        channelNames.push(name);
      }
      ids.push(id);
    }
    perNodeChannels.push(ids);
  }

  return { channelNames, perNodeChannels };
}

/**
 * The only two functions in the codebase permitted to fabricate a branded
 * NodeIndex/Version from a raw primitive. Deliberately unexported: every other
 * module can only obtain one of these by receiving an already-parsed Graph out
 * of parseRawGraph/parseTrimmedGraph below.
 */
function mintVersion(raw: string): Version {
  return raw as Version;
}
function mintNodeIndex(raw: number): NodeIndex {
  return raw as NodeIndex;
}

function mapMatchingRule(raw: RawMatchingRule): MatchingRule {
  if (raw.type === 'Always') {
    return { type: 'Always' };
  }
  return { type: 'PromQL', promql: raw.promql.promql };
}

function mapRisk(raw: RawRisk): Risk {
  return {
    url: raw.url,
    name: raw.name,
    message: raw.message,
    matchingRules: raw.matchingRules.map(mapMatchingRule),
  };
}

function mapConditionalEdgeGroup(raw: RawConditionalEdgeGroup): ConditionalEdgeGroup {
  return {
    edges: raw.edges.map((e) => ({ from: mintVersion(e.from), to: mintVersion(e.to) })),
    risks: raw.risks.map(mapRisk),
  };
}

function zodIssues(error: z.ZodError): ReadonlyArray<{ path: PropertyKey[]; message: string }> {
  return error.issues.map((issue) => ({ path: issue.path, message: issue.message }));
}

/**
 * Validates and converts a freshly fetched (or otherwise untrusted) API
 * response into the app's internal Graph representation.
 *
 * Two things happen here that nowhere else in the codebase is allowed to do:
 *  - branding raw index numbers as NodeIndex and raw strings as Version
 *  - detecting the "HTTP 200 with empty arrays" invalid-channel response and
 *    surfacing it as a distinct `empty` error rather than a valid empty Graph
 */
export function parseRawGraph(
  input: unknown,
  context: Readonly<{ channel: string; arch: string }>,
): Result<Graph, GraphError> {
  const parsed = rawGraphResponseSchema.safeParse(input);
  if (!parsed.success) {
    return err({
      kind: 'validation',
      message: 'Graph response did not match the expected shape.',
      issues: zodIssues(parsed.error),
    });
  }
  const raw = parsed.data;

  // Cincinnati returns HTTP 200 with empty arrays for an unknown/invalid
  // channel -- never a 404. Content, not status code, is the signal.
  if (raw.nodes.length === 0) {
    return err({ kind: 'empty', channel: context.channel, arch: context.arch });
  }

  const nodeCount = raw.nodes.length;
  for (const [from, to] of raw.edges) {
    if (from >= nodeCount || to >= nodeCount) {
      return err({
        kind: 'validation',
        message: `Edge index out of range: [${from}, ${to}] against ${nodeCount} nodes.`,
      });
    }
  }

  const { channelNames, perNodeChannels } = internChannels(
    raw.nodes.map((n) => n.metadata?.[CHANNELS_METADATA_KEY]),
  );

  const nodes: GraphNode[] = raw.nodes.map((n, i) => ({
    version: mintVersion(n.version),
    payload: n.payload,
    errataUrl: n.metadata?.url,
    channels: perNodeChannels[i] ?? [],
  }));

  const edges: Array<readonly [NodeIndex, NodeIndex]> = raw.edges.map(
    ([from, to]) => [mintNodeIndex(from), mintNodeIndex(to)] as const,
  );

  const conditionalEdges: ConditionalEdgeGroup[] = raw.conditionalEdges.map(mapConditionalEdgeGroup);

  return ok({ nodes, edges, conditionalEdges, channelNames });
}

/**
 * Resolves an untrusted bare string -- e.g. a `?start=4.18.2` URL query
 * parameter -- to a branded `Version`, but *only* if it names an exact node
 * in `graph`. This is the boundary Phase 3 uses to mint a `Version` from
 * user/URL input outside a fresh fetch: it deliberately does NOT call
 * `mintVersion` above (which stays unexported and un-reachable from
 * application code). Instead it looks up the already-branded value a real
 * `GraphNode` already carries and hands that back -- so the brand is never
 * fabricated from an arbitrary string, only ever confirmed against data that
 * has already passed through this module's own validation. An unknown or
 * garbage string simply resolves to `undefined`, making "the URL named a
 * version this graph doesn't have" a handled case rather than a type-system
 * hole plugged with an `as Version` cast.
 */
export function resolveVersion(graph: Graph, raw: string): Version | undefined {
  return graph.nodes.find((n) => n.version === raw)?.version;
}

/**
 * Validates and converts a value read back out of the localStorage cache tier.
 * localStorage is untrusted (another tab, a previous app version's shape, or
 * plain corruption can all end up there), so this re-runs full structural
 * validation rather than trusting the stored JSON -- it does not assume the
 * value was ever produced by this app's own `toStorable`.
 */
export function parseTrimmedGraph(input: unknown): Result<Graph, GraphError> {
  const parsed = trimmedGraphSchema.safeParse(input);
  if (!parsed.success) {
    return err({
      kind: 'validation',
      message: 'Cached graph did not match the expected shape.',
      issues: zodIssues(parsed.error),
    });
  }
  const raw = parsed.data;

  const nodeCount = raw.nodes.length;
  for (const [from, to] of raw.edges) {
    if (from >= nodeCount || to >= nodeCount) {
      return err({
        kind: 'validation',
        message: `Cached edge index out of range: [${from}, ${to}] against ${nodeCount} nodes.`,
      });
    }
  }

  const channelCount = raw.channelNames.length;
  for (const n of raw.nodes) {
    for (const c of n.channels) {
      if (c >= channelCount) {
        return err({
          kind: 'validation',
          message: `Cached channel id ${c} out of range against ${channelCount} channel names.`,
        });
      }
    }
  }

  const nodes: GraphNode[] = raw.nodes.map((n) => ({
    version: mintVersion(n.version),
    payload: n.payload,
    errataUrl: n.errataUrl,
    channels: n.channels,
  }));

  const edges: Array<readonly [NodeIndex, NodeIndex]> = raw.edges.map(
    ([from, to]) => [mintNodeIndex(from), mintNodeIndex(to)] as const,
  );

  const conditionalEdges: ConditionalEdgeGroup[] = raw.conditionalEdges.map((group) => ({
    edges: group.edges.map((e) => ({ from: mintVersion(e.from), to: mintVersion(e.to) })),
    risks: group.risks.map((r) => ({
      url: r.url,
      name: r.name,
      message: r.message,
      matchingRules: r.matchingRules.map((mr): MatchingRule =>
        mr.type === 'Always' ? { type: 'Always' } : { type: 'PromQL', promql: mr.promql },
      ),
    })),
  }));

  return ok({ nodes, edges, conditionalEdges, channelNames: raw.channelNames });
}
