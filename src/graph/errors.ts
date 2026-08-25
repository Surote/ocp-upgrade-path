/**
 * Every failure mode graph fetching/parsing/caching can produce, as a discriminated
 * union rather than a thrown exception -- callers are forced to handle each kind
 * explicitly (in particular, "empty" must never be treated as "success with no data").
 */
export type GraphError =
  | Readonly<{
      kind: 'validation';
      message: string;
      /** zod issues, when the failure came from schema validation. */
      issues?: ReadonlyArray<{ path: PropertyKey[]; message: string }>;
    }>
  | Readonly<{
      /**
       * The API returned HTTP 200 with `{nodes: [], edges: [], conditionalEdges: []}`.
       * Confirmed live behaviour for an invalid/unknown channel name -- Cincinnati
       * never 404s. This must be surfaced as a distinct, named condition, not as a
       * "successful" empty graph.
       */
      kind: 'empty';
      channel: string;
      arch: string;
    }>
  | Readonly<{
      kind: 'network';
      message: string;
      status?: number;
    }>
  | Readonly<{
      kind: 'aborted';
    }>;

export function describeGraphError(error: GraphError): string {
  switch (error.kind) {
    case 'validation':
      return `Graph response failed validation: ${error.message}`;
    case 'empty':
      return `Channel "${error.channel}" (${error.arch}) not found or empty.`;
    case 'network':
      return error.status
        ? `Graph fetch failed with HTTP ${error.status}: ${error.message}`
        : `Graph fetch failed: ${error.message}`;
    case 'aborted':
      return 'Graph fetch was aborted.';
  }
}
