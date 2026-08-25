import { channelNamesForNode } from '../design/channels';
import type { GraphNode, Version } from '../graph/types';
import { CopyButton } from './CopyButton';

/**
 * The per-station panel opened by clicking/activating a station on the map
 * (plan.md §6): errata link, payload digest, channel membership. Errata is
 * *omitted* (not rendered as a dead link) when absent -- 17/171
 * `candidate-4.20` nodes have no advisory yet.
 *
 * `channelNames` is only trustworthy when the whole result came from a
 * single fetched graph (`!multiGraph`) -- see design/channels.ts's doc for
 * why a stitched multi-graph result can't safely resolve channel-membership
 * indices at all (each source graph has its own name table, and
 * `StitchedPathResult` doesn't carry one per source).
 */
export function NodeDetail({
  version,
  node,
  channelNames,
  multiGraph,
}: {
  readonly version: Version | undefined;
  readonly node: GraphNode | undefined;
  readonly channelNames: readonly string[];
  readonly multiGraph: boolean;
}) {
  if (!version) {
    return (
      <section className="panel panel--node-detail" aria-labelledby="node-detail-heading">
        <h2 id="node-detail-heading">Station detail</h2>
        <p className="panel__hint">Select a station on the map to see its advisory, digest and channel membership.</p>
      </section>
    );
  }

  const channels = multiGraph ? [] : channelNamesForNode(node, channelNames);

  return (
    <section className="panel panel--node-detail" aria-labelledby="node-detail-heading">
      <h2 id="node-detail-heading">
        Station <span className="mono">{version}</span>
      </h2>

      <dl className="node-detail-list">
        <div>
          <dt>Advisory</dt>
          <dd>
            {node?.errataUrl ? (
              <a href={node.errataUrl} target="_blank" rel="noopener noreferrer">
                {node.errataUrl} ↗
              </a>
            ) : (
              <span className="text-muted">No advisory published yet (common for release candidates).</span>
            )}
          </dd>
        </div>

        {node?.payload && (
          <div>
            <dt>Release digest</dt>
            <dd>
              <div className="command-line">
                <code className="digest">{node.payload}</code>
                <CopyButton text={node.payload} />
              </div>
            </dd>
          </div>
        )}

        <div>
          <dt>Channel membership</dt>
          <dd>
            {multiGraph ? (
              <span className="text-muted">
                Not shown: this result was assembled across multiple channels, so a single channel table can't be trusted for
                this station.
              </span>
            ) : channels.length > 0 ? (
              <ul className="chip-list">
                {channels.map((name) => (
                  <li key={name} className="chip">
                    {name}
                  </li>
                ))}
              </ul>
            ) : (
              <span className="text-muted">No channel membership recorded.</span>
            )}
          </dd>
        </div>
      </dl>
    </section>
  );
}
