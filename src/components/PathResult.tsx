import { useState } from 'react';
import { buildHopCommands } from '../design/commands';
import type { StitchedPathResult, StitchError } from '../engine/types';
import type { Version } from '../graph/types';
import { describeStitchError } from '../planner/describeStitchError';
import type { AsyncResult } from '../planner/useAsyncResult';
import { AdminAcksPanel } from './AdminAcksPanel';
import { AlternatesPanel } from './AlternatesPanel';
import { CommandScript } from './CommandScript';
import { EusAdvisory } from './EusAdvisory';
import { HopDetail } from './HopDetail';
import { NodeDetail } from './NodeDetail';
import { RiskSummary } from './RiskSummary';
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
}: {
  readonly result: AsyncResult<StitchedPathResult, StitchError>;
  readonly channel: string | undefined;
  readonly channelNames: readonly string[];
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

  const { primary, alternates, stitch, nodeInfo } = result.value;
  const commands = buildHopCommands(primary, channel, nodeInfo, {
    channelNames,
    multiGraph: stitch.multiGraph,
  });
  const start = primary.versions[0];
  const target = primary.versions[primary.versions.length - 1];

  const toggleHop = (index: number) => setSelectedHop((prev) => (prev === index ? null : index));
  const toggleStation = (index: number) => setSelectedStation((prev) => (prev === index ? null : index));

  return (
    <div aria-live="polite">
      <StitchBanner channelsUsed={stitch.channelsUsed} classFallbacks={stitch.classFallbacks} />
      <RouteSummary path={primary} />

      <UpgradeMap
        path={primary}
        nodeInfo={nodeInfo}
        commands={commands}
        selectedHopIndex={selectedHop}
        selectedStationIndex={selectedStation}
        onSelectHop={toggleHop}
        onSelectStation={toggleStation}
      />

      <div className="detail-grid">
        <HopDetail hop={selectedHop !== null ? primary.hops[selectedHop] : undefined} command={selectedHop !== null ? commands[selectedHop] : undefined} index={selectedHop} total={primary.hops.length} />
        <NodeDetail
          version={selectedStation !== null ? (primary.versions[selectedStation] as Version) : undefined}
          node={selectedStation !== null ? nodeInfo.get(primary.versions[selectedStation] as Version) : undefined}
          channelNames={channelNames}
          multiGraph={stitch.multiGraph}
        />
      </div>

      <CommandScript commands={commands} />
      <RiskSummary riskSummary={primary.riskSummary} />
      <AdminAcksPanel path={primary} />
      {start && target && <EusAdvisory start={start} target={target} />}
      <AlternatesPanel alternates={alternates} multiGraph={stitch.multiGraph} channelsUsed={stitch.channelsUsed} />
    </div>
  );
}
