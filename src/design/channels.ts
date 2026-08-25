import type { GraphNode } from '../graph/types';

const CHANNEL_NAME_PATTERN = /^([a-z]+)-4\.(\d+)$/;

/** The class prefix of a `<class>-4.<minor>` channel name, e.g. `"stable"` from `"stable-4.20"`. Undefined for a name that doesn't match Cincinnati's naming convention. */
export function channelClassOf(channelName: string): string | undefined {
  const match = CHANNEL_NAME_PATTERN.exec(channelName);
  return match ? match[1] : undefined;
}

/**
 * The minor number in a `<class>-4.<minor>` channel name, e.g. `19` from
 * `"stable-4.19"`. Undefined for a name that doesn't match Cincinnati's
 * naming convention.
 *
 * There is deliberately no inverse `channelNameForMinor(class, minor)` here
 * anymore -- it used to exist and was used to *build* channel names to emit
 * as `oc adm upgrade channel` commands, which is unsound: not every
 * `<class>-4.<minor>` combination is a real, populated channel (EUS channels
 * only exist for even minors 4.6+ -- design/eus.ts), and even when the name
 * happens to exist, naming a channel by class-and-minor ignores whether the
 * destination version is actually a member of it. A channel name must only
 * ever be read from real membership data (`channelNamesForNode`) or from the
 * set of channels the stitcher actually fetched
 * (`StitchedPathResult.stitch.channelsUsed`) -- see design/commands.ts.
 */
export function channelMinorOf(channelName: string): number | undefined {
  const match = CHANNEL_NAME_PATTERN.exec(channelName);
  return match ? Number(match[2]) : undefined;
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
