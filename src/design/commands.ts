import type { Path } from '../engine/types';
import type { GraphNode, Version } from '../graph/types';
import { channelClassOf, channelNamesForNode } from './channels';

export interface HopCommand {
  readonly from: Version;
  readonly to: Version;
  /**
   * The `oc adm upgrade channel <name>` line -- present only when this hop's
   * `sourceChannel` (post-`reattributeEarliestSwitch`, engine/stitch.ts) is
   * genuinely not the channel the cluster is currently tracked as being on
   * (plan.md §6 "The channel-switch rule"). `undefined` when the current
   * channel already covers this hop, which is the common case: crossing a
   * minor does not by itself require a switch.
   *
   * **Attribution**: when present, the switch belongs to this hop's `from`
   * -- the station the cluster is standing on right before taking this hop
   * -- never `to` (plan.md §6 "Where the switch is attributed matters").
   * `sourceChannel` is already reattributed to the earliest member station
   * by the engine, so `from` here is exactly that station; a caller placing
   * a marker (the map's ring, `HopDetail`'s note) must anchor it on `from`.
   */
  readonly channelSwitch?: string;
  /**
   * The bare channel name backing `channelSwitch` (e.g. `stable-4.19`, not
   * the full `oc adm ...` line) -- for callers that need to name the
   * channel inline (the map's interchange tag, plan.md §6) without
   * re-parsing the command string. Present iff `channelSwitch` is. Same
   * attribution rule as `channelSwitch`: the switch is at this hop's `from`.
   */
  readonly channelSwitchTo?: string;
  readonly upgradeTo: string;
  /** Digest form for disconnected clusters, on a secondary line (plan.md §6) -- absent only if this hop's target node has no known payload (shouldn't happen for a validated graph node, but `GraphNode.payload` isn't optional so this is effectively always present when `nodeInfo` has the node at all). */
  readonly upgradeToImage?: string;
}

export interface ChannelContext {
  /**
   * The `channelNames` table belonging to the *currently selected* channel's
   * own fetched graph. Only trustworthy against `nodeInfo` entries that came
   * from that same graph -- see `channelNamesForNode`'s doc in
   * design/channels.ts. Only consulted as the membership-fallback path in
   * `buildHopCommands` (below) -- real `Path`s from the stitcher carry
   * `hop.sourceChannel` and never need it.
   */
  readonly channelNames: readonly string[];
  /**
   * `StitchedPathResult.stitch.multiGraph` -- true when the path was
   * assembled across more than one fetched graph. Guards only the
   * membership-fallback path: when a hop has no `sourceChannel` (a hand-built
   * `Path`, not a real stitcher result) and the result is multi-graph,
   * `nodeInfo` entries can come from a graph other than the one
   * `channelNames` was read from, so membership can't be safely resolved
   * (mismatched source tables) -- see `buildHopCommands`'s doc.
   */
  readonly multiGraph: boolean;
}

/**
 * Preference order for which real channel to switch into once a switch is
 * genuinely required (plan.md §6): prefer a channel of the same class as the
 * one currently active (`stable` -> another `stable-4.N`, etc.) -- that
 * keeps the operator's risk posture consistent across the plan rather than
 * bouncing them onto e.g. `fast` or `candidate` mid-upgrade. If the
 * destination isn't a member of any channel in that class, fall back to the
 * first channel it actually belongs to (real membership data, from
 * `channelNamesForNode`) rather than inventing a name. `undefined` only when
 * the destination has no recorded channel membership at all.
 */
function pickSwitchChannel(memberChannels: readonly string[], preferredClass: string | undefined): string | undefined {
  if (memberChannels.length === 0) return undefined;
  if (preferredClass) {
    const sameClass = memberChannels.find((name) => channelClassOf(name) === preferredClass);
    if (sameClass) return sameClass;
  }
  return memberChannels[0];
}

/**
 * Builds the per-hop `oc adm upgrade` command sequence for one path, per
 * plan.md §6 "The channel-switch rule": emit a switch only when the hop's
 * destination genuinely isn't on the channel the cluster is currently on,
 * and only ever name a channel real data attests to -- never a name
 * assembled from a class and a minor.
 *
 * Two sources of truth feed this, tried in order per hop:
 *
 *  1. **Per-hop provenance** (`hop.sourceChannel`, engine/types.ts) -- set by
 *     the stitcher (engine/stitch.ts) on every hop it returns, single-graph
 *     or multi-graph alike. When present, it *is* the answer: if it differs
 *     from the channel the cluster is currently tracked as being on, that's
 *     a real, already-fetched channel boundary was crossed, and
 *     `hop.sourceChannel` is exactly the (real, fetched -- never fabricated)
 *     channel to switch to. This is what finally makes a genuine
 *     multi-graph stitch emit correct switch commands (plan.md §6
 *     "Look-ahead targets") -- previously impossible because `Path`/`PathHop`
 *     carried no segment attribution at all. It is also, trivially, why a
 *     single-graph path can never need a switch: every hop shares the same
 *     `sourceChannel` (there is only one fetched graph), so this check can
 *     never fire -- matching the verified invariant (plan.md §6: 546 nodes
 *     across 5 fixtures, zero non-members of their own source channel).
 *  2. **Membership fallback** (`channelNames`/`nodeInfo`, the original
 *     mechanism) -- used only when `hop.sourceChannel` is absent, which in
 *     practice means a hand-built `Path` that didn't go through the
 *     stitcher (e.g. a test fixture). Resolves the destination's recorded
 *     `GraphNode.channels` membership against `channelNames` and switches
 *     only when the current channel isn't among them, preferring a
 *     same-class real member (`pickSwitchChannel` below) over any other.
 *     Skipped entirely when `channelContext.multiGraph` is true, since a
 *     multi-graph `nodeInfo` can mix entries from more than one source
 *     graph and `channelNames` only matches one of them (design/channels.ts).
 *
 * The cluster's current channel is tracked hop by hop: it starts as
 * `selectedChannel` and only changes when a switch is actually emitted, so
 * a later hop is judged against wherever the previous switch actually left
 * the cluster, not against the original selection.
 */
export function buildHopCommands(
  path: Path,
  selectedChannel: string | undefined,
  nodeInfo: ReadonlyMap<Version, GraphNode>,
  channelContext: ChannelContext,
): readonly HopCommand[] {
  const { channelNames, multiGraph } = channelContext;
  let currentChannel = selectedChannel;

  return path.hops.map((hop) => {
    const toNode = nodeInfo.get(hop.to);
    let channelSwitchTo: string | undefined;

    if (currentChannel && hop.sourceChannel) {
      // Provenance-based: the real, already-fetched channel that produced
      // this hop is the definitive answer -- see doc above.
      if (hop.sourceChannel !== currentChannel) {
        channelSwitchTo = hop.sourceChannel;
      }
    } else if (currentChannel && !multiGraph) {
      const memberChannels = channelNamesForNode(toNode, channelNames);
      if (!memberChannels.includes(currentChannel)) {
        // memberChannels empty (no channel data recorded for this node) ->
        // pickSwitchChannel returns undefined -> no real name to switch to,
        // so nothing is emitted rather than a guess.
        channelSwitchTo = pickSwitchChannel(memberChannels, channelClassOf(currentChannel));
      }
    }

    if (channelSwitchTo) currentChannel = channelSwitchTo;

    const payload = toNode?.payload;
    return {
      from: hop.from,
      to: hop.to,
      channelSwitch: channelSwitchTo ? `oc adm upgrade channel ${channelSwitchTo}` : undefined,
      channelSwitchTo,
      upgradeTo: `oc adm upgrade --to ${hop.to}`,
      upgradeToImage: payload ? `oc adm upgrade --to-image=${payload} --allow-explicit-upgrade` : undefined,
    };
  });
}

/** The whole hop sequence as one copyable script (plan.md §6), channel-switch lines commented so their purpose is legible in a change request. */
export function buildScript(commands: readonly HopCommand[]): string {
  const lines: string[] = [];
  for (const cmd of commands) {
    if (cmd.channelSwitch) lines.push(`${cmd.channelSwitch}  # destination isn't on the current channel`);
    lines.push(cmd.upgradeTo);
  }
  return lines.join('\n');
}
