import type { GraphError } from '../../graph/errors';
import { parseRawGraph } from '../../graph/parse';
import type { Graph, Version } from '../../graph/types';
import { err, ok } from '../../lib/result';
import type { GraphLoader } from '../types';

export function v(s: string): Version {
  return s as Version;
}

export interface RiskSpec {
  readonly from: string;
  readonly to: string;
  readonly name: string;
  readonly always?: boolean;
}

/**
 * A graph from version-pair edges, through the real parse boundary. A risky
 * edge is listed only in `conditionalEdges`, as Cincinnati sends it; `nodes`
 * adds releases no edge touches. Every node advertises `channels`.
 */
export function graph(
  edges: readonly (readonly [string, string])[],
  opts: { readonly nodes?: readonly string[]; readonly channels?: readonly string[]; readonly risks?: readonly RiskSpec[] } = {},
): Graph {
  const risks = opts.risks ?? [];
  const versions = [...new Set([...(opts.nodes ?? []), ...edges.flat(), ...risks.flatMap((r) => [r.from, r.to])])];
  const index = new Map(versions.map((ver, i) => [ver, i]));
  const isRisky = (from: string, to: string) => risks.some((r) => r.from === from && r.to === to);
  const raw = {
    version: 1,
    nodes: versions.map((version, i) => ({
      version,
      payload: `quay.io/openshift-release-dev/ocp-release@sha256:${i}`,
      metadata: { 'io.openshift.upgrades.graph.release.channels': (opts.channels ?? []).join(',') },
    })),
    edges: edges.filter(([from, to]) => !isRisky(from, to)).map(([from, to]) => [index.get(from), index.get(to)]),
    conditionalEdges: risks.map((r) => ({
      edges: [{ from: r.from, to: r.to }],
      risks: [
        {
          url: `https://issues.example/${r.name}`,
          name: r.name,
          message: r.name,
          matchingRules: [r.always ? { type: 'Always' } : { type: 'PromQL', promql: { promql: 'up' } }],
        },
      ],
    })),
  };
  const parsed = parseRawGraph(raw, { channel: 'test', arch: 'amd64' });
  if (!parsed.ok) throw new Error(`graph: ${JSON.stringify(parsed.error)}`);
  return parsed.value;
}

/** Serves `graphs` by channel name; any other channel is empty, as Cincinnati answers an unknown name. */
export function loaderFor(graphs: Readonly<Record<string, Graph | GraphError>>, fetched: string[] = []): GraphLoader {
  return async (channel, arch) => {
    fetched.push(channel);
    const entry = graphs[channel];
    if (!entry) return err({ kind: 'empty', channel, arch });
    return 'nodes' in entry ? ok(entry) : err(entry);
  };
}
