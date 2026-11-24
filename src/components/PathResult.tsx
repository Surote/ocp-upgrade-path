import { useState } from 'react';
import { buildHopCommands } from '../design/commands';
import type { ControlPlaneOnlyLeg } from '../design/eus';
import type { PathHop, StitchedPathResult, StitchError } from '../engine/types';
import type { Version } from '../graph/types';
import { describeStitchError } from '../planner/describeStitchError';
import type { AsyncResult } from '../planner/useAsyncResult';
import type { RiskApplicabilityViewModel, RouteHold } from '../planner/usePlanner';
import { AdminAcksPanel } from './AdminAcksPanel';
import { AlternatesPanel } from './AlternatesPanel';
import { CommandScript } from './CommandScript';
import { EusAdvisory } from './EusAdvisory';
import { HopDetail } from './HopDetail';
import { LowerRiskRoute } from './LowerRiskRoute';
import { NodeDetail } from './NodeDetail';
import { RiskSummary } from './RiskSummary';
import { channelSequence } from './routeFacts';
import { RouteSummary } from './RouteSummary';
import { StitchBanner } from './StitchBanner';
import { UpgradeMap } from './UpgradeMap';

/**
 * The path-search result region -- Phase 4's real output, replacing the
 * Phase 3 placeholder. Orchestrates the transit map plus everything it
 * reveals on selection; owns only local UI selection state (which hop or
 * station is open), never engine/fetch logic, per the phase constraints.
 */
export function PathResult({
  result,
  channel,
  channelNames,
  controlPlaneOnlyLegs,
  routeHold,
  pinnedStops,
  riskApplicability,
  onUseLowerRisk,
}: {
  readonly result: AsyncResult<StitchedPathResult, StitchError>;
  readonly channel: string | undefined;
  readonly channelNames: readonly string[];
  /** The primary route's legs (planner/useControlPlaneOnlyLegs.ts); a leg's paused hops run on its EUS channel in the commands. */
  readonly controlPlaneOnlyLegs: readonly ControlPlaneOnlyLeg[];
  readonly routeHold?: RouteHold;
  readonly pinnedStops: readonly Version[];
  readonly riskApplicability: RiskApplicabilityViewModel;
  readonly onUseLowerRisk: () => void;
}) {
  const [selectedHop, setSelectedHop] = useState<number | null>(null);
  const [selectedStation, setSelectedStation] = useState<number | null>(null);

  const pathKey = result.status === 'success' ? result.value.primary.versions.join('>') : '';
  // A fresh path (new search) invalidates any prior selection -- an index
  // from the old path could point at a different hop/station in the new
  // one. Adjusted during render (React's documented pattern for resetting
  // state on a prop/derived-value change) rather than in an effect, so
  // there's no extra commit-then-reset render pass.
  const [prevPathKey, setPrevPathKey] = useState(pathKey);
  if (pathKey !== prevPathKey) {
    setPrevPathKey(pathKey);
    setSelectedHop(null);
    setSelectedStation(null);
  }

  if (routeHold === 'invalidStops') {
    return (
      <p className="path-result-error" role="alert">
        Route withheld: remove or replace the flagged stop above.
      </p>
    );
  }
  if (routeHold === 'checkingStops') {
    return (
      <p className="path-result-hint" aria-live="polite" aria-busy="true">
        Checking the pinned stops…
      </p>
    );
  }
  if (result.status === 'idle') {
    return <p className="path-result-hint">Select a channel, start version and target version to find an upgrade path.</p>;
  }
  if (result.status === 'loading') {
    return (
      <p className="path-result-hint" aria-live="polite" aria-busy="true">
        Searching for a path…
      </p>
    );
  }
  if (result.status === 'error') {
    return (
      <p className="path-result-error" role="alert" aria-live="polite">
        {describeStitchError(result.error)}
      </p>
    );
  }

  const { primary, alternates, stitch, stations, riskComparison } = result.value;
  const commands = buildHopCommands(
    primary,
    channel,
    stations,
    {
      channelNames,
      multiGraph: stitch.multiGraph,
    },
    controlPlaneOnlyLegs,
  );

  const toggleHop = (index: number) => setSelectedHop((prev) => (prev === index ? null : index));
  const toggleStation = (index: number) => setSelectedStation((prev) => (prev === index ? null : index));

  return (
    <div aria-live="polite">
      <StitchBanner channels={channelSequence(primary, channel)} classFallbacks={stitch.classFallbacks} />
      <RouteSummary path={primary} notApplicable={riskApplicability.notApplicable} />
      <LowerRiskRoute primary={primary} comparison={riskComparison} notApplicable={riskApplicability.notApplicable} onUse={onUseLowerRisk} />

      <UpgradeMap
        path={primary}
        stations={stations}
        commands={commands}
        pinnedStops={pinnedStops}
        selectedHopIndex={selectedHop}
        selectedStationIndex={selectedStation}
        onSelectHop={toggleHop}
        onSelectStation={toggleStation}
      />

      {selectedHop === null && selectedStation === null ? (
        <p className="map-hint">Select a station or hop on the map for its advisory, commands and risks.</p>
      ) : (
        <div className="detail-grid">
          {selectedHop !== null && (
            <HopDetail
              hop={primary.hops[selectedHop] as PathHop}
              command={commands[selectedHop]}
              index={selectedHop}
              total={primary.hops.length}
              applicability={riskApplicability}
            />
          )}
          {selectedStation !== null && (
            <NodeDetail
              version={primary.versions[selectedStation] as Version}
              node={stations[selectedStation]}
              channelNames={channelNames}
              multiGraph={stitch.multiGraph}
            />
          )}
        </div>
      )}

      <CommandScript commands={commands} />
      <RiskSummary riskSummary={primary.riskSummary} applicability={riskApplicability} />
      <AdminAcksPanel path={primary} />
      <EusAdvisory legs={controlPlaneOnlyLegs} />
      <AlternatesPanel alternates={alternates} channelsUsed={stitch.channelsUsed} />
    </div>
  );
}
