import type { HopCommand } from '../design/commands';
import type { PathHop } from '../engine/types';
import { CopyButton } from './CopyButton';
import { RiskCardList } from './RiskCardList';

/**
 * "Selecting a segment reveals the risks for that specific hop" (design
 * brief). This is the per-hop half of plan.md §5's "risks appear twice,
 * deliberately" -- answers "where does it enter", as distinct from
 * `RiskSummary`'s whole-path "what am I exposed to overall".
 */
export function HopDetail({
  hop,
  command,
  index,
  total,
}: {
  readonly hop: PathHop | undefined;
  readonly command: HopCommand | undefined;
  readonly index: number | null;
  readonly total: number;
}) {
  if (!hop || index === null) {
    return (
      <section className="panel panel--hop-detail" aria-labelledby="hop-detail-heading">
        <h2 id="hop-detail-heading">Hop detail</h2>
        <p className="panel__hint">Select a segment on the map to see the risks and commands for that specific hop.</p>
      </section>
    );
  }

  return (
    <section className="panel panel--hop-detail" aria-labelledby="hop-detail-heading">
      <h2 id="hop-detail-heading">
        Hop {index + 1} of {total}: <span className="mono">{hop.from}</span> → <span className="mono">{hop.to}</span>
      </h2>

      {command?.channelSwitch && (
        <p className="interchange-note">
          <span className="interchange-note__icon" aria-hidden="true">
            ⇄
          </span>
          Switch to <span className="mono">{command.channelSwitchTo}</span> while standing on{' '}
          <span className="mono">{hop.from}</span>, before upgrading to {hop.to} -- {hop.from} is the earliest release on
          this path already in that channel.
        </p>
      )}

      {command && (
        <div className="hop-commands">
          {command.channelSwitch && (
            <div className="command-line">
              <code>{command.channelSwitch}</code>
              <CopyButton text={command.channelSwitch} />
            </div>
          )}
          <div className="command-line">
            <code>{command.upgradeTo}</code>
            <CopyButton text={command.upgradeTo} />
          </div>
          {command.upgradeToImage && (
            <div className="command-line command-line--secondary">
              <code>{command.upgradeToImage}</code>
              <CopyButton text={command.upgradeToImage} />
            </div>
          )}
        </div>
      )}

      <h3>Risks entering {hop.to}</h3>
      <RiskCardList risks={hop.risks} cleanLabel="No known risks on this hop." />
    </section>
  );
}
