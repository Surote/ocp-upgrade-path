import { useState } from 'react';
import './App.css';
import { AiGeneratedBanner } from './components/AiGeneratedBanner';
import { ArchSelect } from './components/ArchSelect';
import { ChannelSelect } from './components/ChannelSelect';
import { FreshnessBanner } from './components/FreshnessBanner';
import { MethodExplainer } from './components/MethodExplainer';
import { Notices } from './components/Notices';
import { PathResult } from './components/PathResult';
import { RouteConstraints } from './components/RouteConstraints';
import { StartSelect } from './components/StartSelect';
import { TargetSelect } from './components/TargetSelect';
import { GraphClient } from './graph/client';
import { usePlanner } from './planner/usePlanner';

export interface AppProps {
  /** Injectable for tests -- production code never passes this, so `App` constructs its own `GraphClient` (real `fetch`, real `localStorage`). */
  readonly graphClient?: GraphClient;
}

/**
 * Layout: header, the control rail (the four cascading dropdowns), the
 * transit map, then whatever detail is selected and the commands, risks and
 * alternates as flat sections. `usePlanner` owns every stateful/async
 * concern; this component is rendering only.
 */
function App({ graphClient }: AppProps = {}) {
  const [client] = useState(() => graphClient ?? new GraphClient());
  const planner = usePlanner(client);

  return (
    <main>
      <header className="app-header">
        <h1>OpenShift Upgrade Path Planner</h1>
        <p className="app-tagline">The safest recommended hop sequence between two OpenShift releases, per Red Hat's own update graph.</p>
        <AiGeneratedBanner />
      </header>

      <Notices notices={planner.notices} />

      <form className="control-rail" aria-label="Path selection">
        <ChannelSelect id="channel" model={planner.channel} />
        <ArchSelect id="arch" model={planner.arch} />
        <StartSelect id="start" model={planner.start} />
        <TargetSelect id="target" model={planner.target} />
      </form>
      <RouteConstraints model={planner.constraints} selectedChannel={planner.channel.value} />

      <FreshnessBanner model={planner.freshness} />

      <section className="result-section" aria-label="Upgrade path result">
        <PathResult
          result={planner.result}
          channel={planner.channel.value || undefined}
          channelNames={planner.channelNames}
          routeHold={planner.routeHold}
          pinnedStops={planner.pinnedStops}
          onUseLowerRisk={() => planner.constraints.onRiskPolicyChange('avoidConditional')}
        />
      </section>

      <MethodExplainer />
    </main>
  );
}

export default App;
