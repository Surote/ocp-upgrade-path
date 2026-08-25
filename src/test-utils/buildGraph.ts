import { parseRawGraph } from '../graph/parse';
import type { Graph } from '../graph/types';

/**
 * Builds a small, valid synthetic Graph by round-tripping a minimal raw API
 * shape through the real parseRawGraph validation boundary -- so test graphs
 * are never hand-assembled with brand-casting shortcuts real code can't take.
 */
export function buildGraph(nodeVersions: readonly string[], edgePairs: ReadonlyArray<readonly [number, number]> = []): Graph {
  const raw = {
    version: 1,
    nodes: nodeVersions.map((version, i) => ({
      version,
      payload: `quay.io/openshift-release-dev/ocp-release@sha256:${i.toString().padStart(64, '0')}`,
      metadata: { url: `https://access.redhat.com/errata/TEST-${i}` },
    })),
    edges: edgePairs.map(([a, b]) => [a, b]),
    conditionalEdges: [],
  };

  const result = parseRawGraph(raw, { channel: 'test-channel', arch: 'amd64' });
  if (!result.ok) {
    throw new Error(`buildGraph: synthetic fixture failed to parse: ${JSON.stringify(result.error)}`);
  }
  return result.value;
}
