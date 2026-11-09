import { type ChannelName, parseChannelName } from '../design/channels';
import { compareStreams } from '../engine/version';

/**
 * Presentation order for a channel's "class" once channels are grouped by
 * stream -- most broadly-recommended first. There is no signal for
 * "recommendedness" on the wire (Cincinnati channel names are just strings);
 * this is a judgment call about what reads best in a dropdown, documented
 * here so it is easy to find and revisit rather than an unexplained
 * ordering array.
 */
const CLASS_ORDER = ['stable', 'eus', 'fast', 'candidate'] as const;

interface ParsedChannel extends ChannelName {
  readonly raw: string;
}

function classRank(cls: string): number {
  const i = CLASS_ORDER.indexOf(cls as (typeof CLASS_ORDER)[number]);
  return i === -1 ? CLASS_ORDER.length : i;
}

/**
 * Sorts channel names by stream (descending -- newest first, `5.0` before
 * `4.22`, matching the newest-first convention used for version dropdowns
 * elsewhere), then by channel class in the fixed order above -- never lexically, which would
 * sort e.g. `stable-4.9` after `stable-4.18` as strings (plan.md §6 / Q7).
 *
 * A name that doesn't match the `<class>-<major>.<minor>` shape Cincinnati uses
 * today (an unexpected future channel naming) is not dropped or crashed on:
 * it sorts after every recognised name, in plain lexical order among the
 * other unrecognised names.
 */
export function sortChannels(names: readonly string[]): readonly string[] {
  const parsed: ParsedChannel[] = [];
  const unparsed: string[] = [];
  for (const name of names) {
    const p = parseChannelName(name);
    if (p) parsed.push({ ...p, raw: name });
    else unparsed.push(name);
  }

  parsed.sort((a, b) => {
    const streamDiff = compareStreams(b, a);
    if (streamDiff !== 0) return streamDiff;
    const rankDiff = classRank(a.cls) - classRank(b.cls);
    if (rankDiff !== 0) return rankDiff;
    return a.cls.localeCompare(b.cls);
  });
  unparsed.sort((a, b) => a.localeCompare(b));

  return [...parsed.map((p) => p.raw), ...unparsed];
}
