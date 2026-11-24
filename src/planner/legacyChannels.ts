import { formatChannelName, parseChannelName } from '../design/channels';
import { isEusMinor } from '../design/eus';
import { compareStreams, type Stream } from '../engine/version';
import type { GraphError } from '../graph/errors';
import type { Graph } from '../graph/types';
import type { Result } from '../lib/result';

/** The oldest stream the channel list offers: upgrade paths start from 4.14 at the earliest. */
export const OLDEST_LISTED_STREAM: Stream = { major: 4, minor: 14 };

const PROBE_CONCURRENCY = 3;
const PROBE_ATTEMPTS = 2;
const PROBE_CLASSES = ['stable', 'eus', 'fast', 'candidate'] as const;

/** False only for a conventional channel name older than `OLDEST_LISTED_STREAM`. */
export function isListedChannel(name: string): boolean {
  const parsed = parseChannelName(name);
  return parsed === undefined || compareStreams(parsed, OLDEST_LISTED_STREAM) >= 0;
}

export function oldestStream(channelNames: readonly string[]): Stream | undefined {
  let oldest: Stream | undefined;
  for (const name of channelNames) {
    const parsed = parseChannelName(name);
    if (parsed && (!oldest || compareStreams(parsed, oldest) < 0)) oldest = { major: parsed.major, minor: parsed.minor };
  }
  return oldest;
}

/**
 * Channel names to probe for every stream below `oldest`, down to
 * `OLDEST_LISTED_STREAM`. Ordered by class, stable first, and newest stream
 * first within a class: the first few graphs' membership already names most
 * of the rest (a 4.15 graph names every 4.14 channel), so later names are
 * usually skipped as known rather than fetched.
 */
export function legacyProbeNames(oldest: Stream): readonly string[] {
  // Minors can't be counted back across a major boundary; 4.x is the only major with legacy streams.
  if (oldest.major !== OLDEST_LISTED_STREAM.major) return [];
  const names: string[] = [];
  for (const cls of PROBE_CLASSES) {
    for (let minor = oldest.minor - 1; minor >= OLDEST_LISTED_STREAM.minor; minor -= 1) {
      if (cls === 'eus' && !isEusMinor(minor)) continue;
      names.push(formatChannelName({ cls, major: oldest.major, minor }));
    }
  }
  return names;
}

export type ProbeOutcome =
  | { readonly kind: 'present'; readonly channel: string; readonly memberOf: readonly string[] }
  | { readonly kind: 'empty'; readonly channel: string };

/**
 * Fetches each of `names` not already in `known` (or named by a graph this
 * run fetched), `PROBE_CONCURRENCY` at a time, reporting each answer through
 * `onOutcome`. An empty graph is a definite "no such channel"; any other
 * failure is retried once at the back of the queue and otherwise dropped
 * unreported, so nothing records it as absent.
 */
export async function probeChannels(
  probe: (channel: string) => Promise<Result<Graph, GraphError>>,
  names: readonly string[],
  known: ReadonlySet<string>,
  onOutcome: (outcome: ProbeOutcome) => void,
): Promise<void> {
  const queue = names.map((channel) => ({ channel, attempt: 1 }));
  const seen = new Set(known);
  let aborted = false;

  const worker = async () => {
    for (let item = queue.shift(); item && !aborted; item = queue.shift()) {
      if (seen.has(item.channel)) continue;
      const result = await probe(item.channel);
      if (result.ok) {
        seen.add(item.channel);
        for (const name of result.value.channelNames) seen.add(name);
        onOutcome({ kind: 'present', channel: item.channel, memberOf: result.value.channelNames });
      } else if (result.error.kind === 'empty') {
        onOutcome({ kind: 'empty', channel: item.channel });
      } else if (result.error.kind === 'aborted') {
        aborted = true;
      } else if (item.attempt < PROBE_ATTEMPTS) {
        queue.push({ channel: item.channel, attempt: item.attempt + 1 });
      }
    }
  };
  await Promise.all(Array.from({ length: PROBE_CONCURRENCY }, worker));
}
