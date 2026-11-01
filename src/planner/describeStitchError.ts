import { formatChannelName, parseChannelName } from '../design/channels';
import { describeGraphError } from '../graph/errors';
import type { StitchError } from '../engine/types';

/**
 * Human-readable message for every `StitchError` variant (engine/types.ts),
 * for the plain-text result region -- Phase 4 owns real presentation, this
 * just proves every case is handled. `loadFailed` in particular must name
 * *which* channel fetch failed (plan.md §6: "the error names which channel
 * fetch failed"), which is exactly the field `StitchError.loadFailed`
 * carries.
 */
export function describeStitchError(error: StitchError): string {
  switch (error.kind) {
    case 'invalidChannel':
      return `"${error.channel}" is not a recognised channel name (expected "<class>-<major>.<minor>", e.g. "stable-4.22").`;
    case 'loadFailed':
      return error.error.kind === 'empty'
        ? `Channel "${error.channel}" has no releases published${candidateHint(error.channel)}.`
        : `Failed to load channel "${error.channel}": ${describeGraphError(error.error)}`;
    case 'startNeverFound':
      return `Start version ${error.start} was not found in any of: ${error.channelsTried.join(', ')}.`;
    case 'targetNeverFound':
      return `Target version ${error.target} was not found in any of: ${error.channelsTried.join(', ')} -- no channel walking forward from the selected channel reaches it.`;
    case 'startNotFound':
      return `Start version ${error.start} is not a node in this channel's graph.`;
    case 'targetOlder':
      return `Target ${error.target} is older than start ${error.start} -- Cincinnati edges never represent a downgrade.`;
    case 'unreachable':
      return error.nearestReachable
        ? `No path found from ${error.start} to ${error.target}. Nearest reachable version: ${error.nearestReachable}.`
        : `No path found from ${error.start} to ${error.target}.`;
  }
}

/** A new stream is published to `candidate` before `fast`/`stable` (5.0 was candidate-only at first), so point there. */
function candidateHint(channel: string): string {
  const parsed = parseChannelName(channel);
  if (!parsed || parsed.cls === 'candidate') return '';
  return ` yet -- a new stream often appears only in "${formatChannelName({ ...parsed, cls: 'candidate' })}" first`;
}
