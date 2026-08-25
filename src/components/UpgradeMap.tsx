import type { KeyboardEvent } from 'react';
import type { HopCommand } from '../design/commands';
import { laneClassName } from '../design/lanes';
import { riskClass } from '../engine/risks';
import { parseVersion } from '../engine/version';
import type { Path } from '../engine/types';
import type { GraphNode, Version } from '../graph/types';

/*
 * Geometry -- scaled to roughly two-thirds of the design-review pass that
 * preceded it (that pass fixed an *earlier*, too-timid map; this is a
 * distinct, smaller correction on top of it, not a reversion). Every
 * pixel constant below carries forward the same ~2/3 ratio, so the map's
 * proportions -- and the "every band is real content, not dead space"
 * tight-fit `MAP_HEIGHT` -- are unchanged, just smaller. Vertical offsets
 * are still measured from `ROW_Y` using the fixed terminal radius
 * (`R_TERMINAL`), not each station's own radius, so labels stay aligned
 * across terminal and intermediate stations.
 */
const STATION_GAP = 140;
const MARGIN_X = 50;
const R = 17; // intermediate station radius
const R_TERMINAL = 21; // start/target station radius

const ROW_Y = 61;
const CAPTION_Y = ROW_Y - (R_TERMINAL + 17); // "START"/"TARGET"
const LABEL_Y = ROW_Y + (R_TERMINAL + 17); // version number
const TAG_Y = LABEL_Y + 15; // "switch to <channel>" note, interchange stations only
const MAP_HEIGHT = TAG_Y + 12; // tight-fit: every band above is real content, not void

type RiskState = 'always' | 'conditional' | 'clean';

function hopRiskState(risks: Path['hops'][number]['risks']): RiskState {
  if (risks.some((r) => riskClass(r) === 'Always')) return 'always';
  if (risks.length > 0) return 'conditional';
  return 'clean';
}

/** Activates on Enter/Space, matching native button behaviour, for a non-native interactive element (an SVG `<g>`). */
function handleActivateKey(e: KeyboardEvent, activate: () => void) {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    activate();
  }
}

const RISK_GLYPH: Record<RiskState, string> = { always: '▲', conditional: '◆', clean: '✓' };
const RISK_WORD: Record<RiskState, string> = { always: 'always risk', conditional: 'conditional risk', clean: 'clean' };

/**
 * The signature transit map (design brief): one lane colour per minor
 * (design/lanes.ts), stations for releases, an unmissable interchange
 * marker (a ring around the station, the standard transit-map idiom for
 * "this stop connects to a different line") on the station a hop's
 * `HopCommand` carrying a `channelSwitch` **departs from** -- **not**
 * wherever the hop merely crosses a minor (plan.md §6 "The channel-switch
 * rule": those are not the same thing, and conflating them was defect 1),
 * and **not** the station the switching hop arrives at (plan.md §6 "Where
 * the switch is attributed matters": the `oc adm upgrade channel` command
 * runs while the cluster is standing on the *departure* station -- that's
 * the earliest point the destination channel is genuinely reachable, per
 * `engine/stitch.ts`'s `reattributeEarliestSwitch` -- not the station the
 * following `--to` lands on). Risk rides directly on the segment (as a pill
 * sitting *on* the lane line, not floating above it) rather than hidden
 * behind a click. Hand-built SVG, deterministic geometry -- no layout
 * library, per plan.md §6.
 *
 * `commands` must be the same array `CommandScript`/`HopDetail` render, so
 * the map's ring and the Commands panel can never disagree about whether a
 * given hop needs a switch -- one source of truth (design/commands.ts).
 *
 * The interchange marker is made self-explanatory at the station itself
 * (an inline "⇄ switch to <channel>" tag naming the real destination
 * channel, plus an aria-label saying the same in words) rather than relying
 * on a legend entry the user has to go find -- and the legend only lists
 * the interchange symbol at all when at least one ring is actually on
 * screen, since explaining a symbol that isn't present is just noise (and
 * per the channel-switch-rule fix, most paths now have zero interchanges).
 *
 * Scales to its container: `width: 100%` with a `viewBox` doing the actual
 * scaling, `min-width` floored at the map's own natural size so text never
 * shrinks below legibility on a narrow viewport -- `.map-scroll`'s own
 * `overflow-x: auto` (App.css) takes over only once the container is
 * narrower than that floor, per the quality floor's "map scrolls in its own
 * container" rule.
 *
 * Both stations and segments are real interactive elements (`role="button"`,
 * `tabIndex=0`, Enter/Space via `handleActivateKey`) with their own visible
 * focus styling (`outline`, App.css) -- never a click handler on a bare,
 * unfocusable `<path>`.
 */
export function UpgradeMap({
  path,
  nodeInfo,
  commands,
  selectedHopIndex,
  selectedStationIndex,
  onSelectHop,
  onSelectStation,
}: {
  readonly path: Path;
  readonly nodeInfo: ReadonlyMap<Version, GraphNode>;
  readonly commands: readonly HopCommand[];
  readonly selectedHopIndex: number | null;
  readonly selectedStationIndex: number | null;
  readonly onSelectHop: (index: number) => void;
  readonly onSelectStation: (index: number) => void;
}) {
  const versions = path.versions;
  const n = versions.length;
  const width = MARGIN_X * 2 + STATION_GAP * Math.max(n - 1, 0);
  const minors = versions.map((v) => parseVersion(v).minor);
  const hasInterchange = commands.some((c) => c.channelSwitch);

  return (
    <div className="map-wrap">
      <div className="map-scroll">
        <svg
          className="upgrade-map"
          viewBox={`0 0 ${width} ${MAP_HEIGHT}`}
          style={{ width: '100%', minWidth: `${width}px`, height: 'auto', display: 'block' }}
          preserveAspectRatio="xMidYMid meet"
          role="group"
          aria-label="Interactive upgrade path map. Tab through stations and hops for details."
        >
          {path.hops.map((hop, i) => {
            const x1 = MARGIN_X + STATION_GAP * i;
            const x2 = MARGIN_X + STATION_GAP * (i + 1);
            const midX = (x1 + x2) / 2;
            const toMinor = minors[i + 1] as number;
            const state = hopRiskState(hop.risks);
            const selected = selectedHopIndex === i;
            const totalRisks = hop.risks.length;

            const ariaLabel = `Hop ${i + 1} of ${path.hops.length}: ${hop.from} to ${hop.to}. ${
              state === 'clean' ? 'No known risks.' : `${totalRisks} risk${totalRisks === 1 ? '' : 's'}, ${RISK_WORD[state]}.`
            }`;

            return (
              // biome-ignore lint: hops are order-stable, index is a valid key
              <g
                key={i}
                className={`hop-segment hop-segment--${state}${selected ? ' is-selected' : ''}`}
                tabIndex={0}
                role="button"
                aria-pressed={selected}
                aria-label={ariaLabel}
                onClick={() => onSelectHop(i)}
                onKeyDown={(e) => handleActivateKey(e, () => onSelectHop(i))}
              >
                <line x1={x1} y1={ROW_Y} x2={x2} y2={ROW_Y} className="hop-segment__hit" />
                <line x1={x1} y1={ROW_Y} x2={x2} y2={ROW_Y} className={`hop-segment__line ${laneClassName(toMinor)}`} />
                {/* The risk pill sits directly ON the lane line (same y as
                    the line), not floating above it -- an annotation
                    anchored to its segment, drawn after the line so it
                    reads as a capsule inset into the route, the way a real
                    transit map marks a stop-specific note on the line
                    itself. */}
                <g transform={`translate(${midX}, ${ROW_Y})`} className={`risk-pill risk-pill--${state}`}>
                  <rect x={-20} y={-9} width={40} height={18} rx={9} />
                  <text x={0} y={3} textAnchor="middle" aria-hidden="true">
                    {RISK_GLYPH[state]}
                    {state === 'clean' ? '' : ` ${totalRisks}`}
                  </text>
                </g>
              </g>
            );
          })}

          {versions.map((version, i) => {
            const x = MARGIN_X + STATION_GAP * i;
            const minor = minors[i] as number;
            const isStart = i === 0;
            const isTarget = i === n - 1;
            const isTerminal = isStart || isTarget;
            // Interchange = an actually-emitted channel switch on the hop
            // *departing* this station (design/commands.ts), never a bare
            // minor crossing, and never the station the switching hop
            // arrives at -- plan.md §6 "Where the switch is attributed
            // matters": the switch runs while the cluster is standing here,
            // before it takes this hop. See module doc.
            const departingCommand = i < commands.length ? commands[i] : undefined;
            const isInterchange = Boolean(departingCommand?.channelSwitch);
            const switchTo = departingCommand?.channelSwitchTo;
            const node = nodeInfo.get(version);
            const hasErrata = Boolean(node?.errataUrl);
            const incomingRisks = i > 0 ? (path.hops[i - 1]?.risks.length ?? 0) : undefined;
            const incomingState = i > 0 && path.hops[i - 1] ? hopRiskState((path.hops[i - 1] as Path['hops'][number]).risks) : undefined;
            const selected = selectedStationIndex === i;
            const radius = isTerminal ? R_TERMINAL : R;

            const parts: string[] = [`Station ${version}`];
            if (isStart) parts.push('start');
            if (isTarget) parts.push('target');
            if (isInterchange) parts.push(`interchange — switch to channel ${switchTo} before this hop`);
            parts.push(hasErrata ? 'advisory available' : 'no advisory published yet');
            if (incomingRisks !== undefined) {
              parts.push(incomingRisks > 0 ? `${incomingRisks} risk(s) entering this release` : 'no risks entering this release');
            }

            return (
              <g
                key={version}
                className={`station${isTerminal ? ' station--terminal' : ''}${isInterchange ? ' station--interchange' : ''}${
                  selected ? ' is-selected' : ''
                }`}
                transform={`translate(${x}, ${ROW_Y})`}
                tabIndex={0}
                role="button"
                aria-pressed={selected}
                aria-label={parts.join(', ')}
                onClick={() => onSelectStation(i)}
                onKeyDown={(e) => handleActivateKey(e, () => onSelectStation(i))}
              >
                {/* Interchange = a ring around the station -- the standard
                    transit-map mark for "this stop connects to another
                    line" -- drawn where the ring is part of the station
                    itself rather than a small glyph floating above the row.
                    The inline tag below names the real destination channel
                    so the ring is self-explanatory without the legend. */}
                {isInterchange && <circle r={radius + 6} className="interchange-ring" aria-hidden="true" />}
                <circle r={radius} className={`station__dot ${laneClassName(minor)}`} />
                {!hasErrata && <circle r={radius + 3} className="station__no-advisory-ring" aria-hidden="true" />}

                <text className="station__caption" y={CAPTION_Y - ROW_Y} textAnchor="middle" aria-hidden="true">
                  {isStart ? 'START' : isTarget ? 'TARGET' : ''}
                </text>

                <text className="station__label" y={LABEL_Y - ROW_Y} textAnchor="middle" aria-hidden="true">
                  <tspan>{version}</tspan>
                  {/* Risk-count badge lives inline with the label, at the
                      same fixed baseline every station uses -- and is
                      omitted entirely at zero, since a "0" badge repeats
                      what the green clean pill already says (plan.md §6
                      means "a count worth showing", not literal zero). */}
                  {incomingRisks !== undefined && incomingRisks > 0 && incomingState && incomingState !== 'clean' && (
                    <tspan className={`station__risk-count station__risk-count--${incomingState}`} dx={5}>
                      {RISK_GLYPH[incomingState]} {incomingRisks}
                    </tspan>
                  )}
                </text>

                {isInterchange && (
                  <text className="interchange-tag" y={TAG_Y - ROW_Y} textAnchor="middle" aria-hidden="true">
                    ⇄ switch to {switchTo}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      </div>

      <ul className="map-legend" aria-hidden="true">
        <li className="map-legend__item map-legend__item--always">▲ always risk</li>
        <li className="map-legend__item map-legend__item--conditional">◆ conditional risk</li>
        <li className="map-legend__item map-legend__item--clean">✓ clean hop</li>
        {/* Only shown when a ring is actually on the map -- a legend entry
            for a symbol that isn't present is noise, not help. */}
        {hasInterchange && <li className="map-legend__item map-legend__item--interchange">⇄ ring = channel switch required</li>}
      </ul>
    </div>
  );
}
