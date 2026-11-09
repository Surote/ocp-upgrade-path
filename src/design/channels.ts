import type { GraphNode } from '../graph/types';
import type { Stream } from '../engine/version';

/** A parsed `<class>-<major>.<minor>` channel name, e.g. `candidate-5.0`. */
export interface ChannelName extends Stream {
  readonly cls: string;
}

const CHANNEL_NAME_PATTERN = /^([a-z]+)-(\d+)\.(\d+)$/;

/** Parses a Cincinnati channel name. Undefined for a name outside the `<class>-<major>.<minor>` convention. */
export function parseChannelName(name: string): ChannelName | undefined {
  const match = CHANNEL_NAME_PATTERN.exec(name);
  if (!match) return undefined;
  const [, cls, major, minor] = match;
  return { cls: cls as string, major: Number(major), minor: Number(minor) };
}

/**
 * Formats a channel name for *probing* only (design/forwardChannel.ts):
 * the caller must fetch it and treat an empty graph as "doesn't exist",
 * because not every class/stream combination is a real channel (EUS is
 * even-minor only, 5.0 had only `candidate` at first) -- plan.md §2.
 *
 * Never use this to name a channel in an `oc adm upgrade channel` command.
 * Those names come only from real membership data (`channelNamesForNode`)
 * or from channels the stitcher actually fetched
 * (`StitchedPathResult.stitch.channelsUsed`) -- see design/commands.ts.
 */
export function formatChannelName(channel: ChannelName): string {
  return `${channel.cls}-${channel.major}.${channel.minor}`;
}

/**
 * Resolves a node's `channels` (indices into a channel-name table, per
 * graph/types.ts `GraphNode.channels`) to actual names, bounds-checked.
 *
 * `nodeInfo` on a `StitchedPathResult` merges `GraphNode`s across every
 * fetched graph ("later channel wins" -- engine/stitch.ts), but each graph
 * has its *own* `channelNames` table, and `StitchedPathResult` does not
 * carry one per source graph. Cross-referencing a node's indices against a
 * channel-name table from a *different* graph than the one that produced
 * them would silently mislabel channel membership. Callers must only pass a
 * `channelNames` table known to match the node's own source graph (in
 * practice: the single-segment case, `!stitch.multiGraph` -- see
 * components/NodeDetail.tsx); out-of-range indices are dropped rather than
 * mapped to the wrong name.
 */
export function channelNamesForNode(node: GraphNode | undefined, channelNames: readonly string[]): readonly string[] {
  if (!node) return [];
  return node.channels.filter((i) => i >= 0 && i < channelNames.length).map((i) => channelNames[i] as string);
}
