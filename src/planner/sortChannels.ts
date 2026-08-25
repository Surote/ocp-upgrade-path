/**
 * Presentation order for a channel's "class" once channels are grouped by
 * minor -- most broadly-recommended first. There is no signal for
 * "recommendedness" on the wire (Cincinnati channel names are just strings);
 * this is a judgment call about what reads best in a dropdown, documented
 * here so it is easy to find and revisit rather than an unexplained
 * ordering array.
 */
const CLASS_ORDER = ['stable', 'eus', 'fast', 'candidate'] as const;

const CHANNEL_NAME_PATTERN = /^([a-z]+)-4\.(\d+)$/;

interface ParsedChannel {
  readonly raw: string;
  readonly cls: string;
  readonly minor: number;
}

function parseChannelName(name: string): ParsedChannel | undefined {
  const match = CHANNEL_NAME_PATTERN.exec(name);
  if (!match) return undefined;
  const [, cls, minorStr] = match;
  return { raw: name, cls: cls as string, minor: Number(minorStr) };
}

function classRank(cls: string): number {
  const i = CLASS_ORDER.indexOf(cls as (typeof CLASS_ORDER)[number]);
  return i === -1 ? CLASS_ORDER.length : i;
}

/**
 * Sorts channel names by minor (descending -- newest minor first, matching
 * the newest-first convention used for version dropdowns elsewhere), then by
 * channel class in the fixed order above -- never lexically, which would
 * sort e.g. `stable-4.9` after `stable-4.18` as strings (plan.md §6 / Q7).
 *
 * A name that doesn't match the `<class>-4.<minor>` shape Cincinnati uses
 * today (an unexpected future channel naming) is not dropped or crashed on:
 * it sorts after every recognised name, in plain lexical order among the
 * other unrecognised names.
 */
export function sortChannels(names: readonly string[]): readonly string[] {
  const parsed: ParsedChannel[] = [];
  const unparsed: string[] = [];
  for (const name of names) {
    const p = parseChannelName(name);
    if (p) parsed.push(p);
    else unparsed.push(name);
  }

  parsed.sort((a, b) => {
    if (a.minor !== b.minor) return b.minor - a.minor;
    const rankDiff = classRank(a.cls) - classRank(b.cls);
    if (rankDiff !== 0) return rankDiff;
    return a.cls.localeCompare(b.cls);
  });
  unparsed.sort((a, b) => a.localeCompare(b));

  return [...parsed.map((p) => p.raw), ...unparsed];
}
