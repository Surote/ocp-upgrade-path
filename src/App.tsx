import { useState } from 'react';
import './App.css';
import { AiGeneratedBanner } from './components/AiGeneratedBanner';
import { ArchSelect } from './components/ArchSelect';
import { ChannelSelect } from './components/ChannelSelect';
import { FreshnessBanner } from './components/FreshnessBanner';
import { MethodExplainer } from './components/MethodExplainer';
import { Notices } from './components/Notices';
import { PathResult } from './components/PathResult';
import { StartSelect } from './components/StartSelect';
import { TargetSelect } from './components/TargetSelect';
import { GraphClient } from './graph/client';
import { usePlanner } from './planner/usePlanner';

export interface AppProps {
  /** Injectable for tests -- production code never passes this, so `App` constructs its own `GraphClient` (real `fetch`, real `localStorage`). */
  readonly graphClient?: GraphClient;
}

/**
 * Phase 4 layout (design brief): a persistent control rail (the four
 * cascading dropdowns) up top, the transit map as the hero, then hop detail,
 * commands and risk summary below -- all driven by `usePlanner`, which owns
 * every stateful/async concern. This component is rendering only.
 */
function App({ graphClient }: AppProps = {}) {
  const [client] = useState(() => graphClient ?? new GraphClient());
  const planner = usePlanner(client);

  return (
    <main>
      <AiGeneratedBanner />

      <header className="app-header">
        <h1>OpenShift Upgrade Path Planner</h1>
        <p className="app-tagline">The safest recommended hop sequence between two OpenShift releases, per Red Hat's own update graph.</p>
      </header>

      <Notices notices={planner.notices} />

      <form className="control-rail" aria-label="Path selection">
        <ChannelSelect id="channel" model={planner.channel} />
        <ArchSelect id="arch" model={planner.arch} />
        <StartSelect id="start" model={planner.start} />
        <TargetSelect id="target" model={planner.target} />
      </form>

      <FreshnessBanner model={planner.freshness} />

      <section className="result-section" aria-label="Upgrade path result">
        <PathResult result={planner.result} channel={planner.channel.value || undefined} channelNames={planner.channelNames} />
      </section>

      <MethodExplainer />
    </main>
  );
}

export default App;
