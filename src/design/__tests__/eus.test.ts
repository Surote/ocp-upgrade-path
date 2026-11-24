import { describe, expect, it } from 'vitest';
import type { PathHop } from '../../engine/types';
import { formatStream, streamOf } from '../../engine/version';
import type { Graph, Risk, Version } from '../../graph/types';
import { parseRawGraph } from '../../graph/parse';
import { eusPublishing, graphOf } from '../../test-utils/eusGraphs';
import { loadFixture } from '../../test-utils/fixtures';
import { type AvailableLeg, controlPlaneOnlyLegs, type EusGraphLookup, eusChannelsToCheck, isEusMinor, legSteps, type ControlPlaneOnlyLeg } from '../eus';

/** A route's hops, each taken from a stable channel's graph. */
function route(...vs: string[]): PathHop[] {
  return vs.slice(1).map((to, i) => ({ from: vs[i] as Version, to: to as Version, risks: [], sourceChannel: 'stable-4.22' }));
}

function legsOf(hops: readonly PathHop[]): readonly ControlPlaneOnlyLeg[] {
  return controlPlaneOnlyLegs(hops, eusPublishing(hops));
}

function describeLeg(leg: ControlPlaneOnlyLeg): string {
  switch (leg.kind) {
    case 'available':
      return `pause@${leg.pauseAt} unpause@${leg.unpauseAt}`;
    case 'checking':
      return `checking ${leg.eusChannel}`;
    case 'unavailable':
      return leg.reason.kind === 'eusNotLoaded'
        ? `unavailable: ${leg.eusChannel} ${leg.reason.error.kind}`
        : `unavailable at ${leg.reason.hop.to} (${leg.reason.kind})`;
  }
}

function summary(legs: readonly ControlPlaneOnlyLeg[]) {
  return legs.map((leg) => `${formatStream(leg.from)}->${formatStream(leg.to)} ${describeLeg(leg)}`);
}

function available(leg: ControlPlaneOnlyLeg | undefined): AvailableLeg {
  if (leg?.kind !== 'available') throw new Error(`expected an available leg, got ${leg?.kind}`);
  return leg;
}

// The live eus-4.18 route for 4.16.33 -> 5.0.1 (plan.md §6).
const LIVE_416_TO_501 = route('4.16.33', '4.17.59', '4.18.59', '4.19.55', '4.20.46', '4.21.42', '4.22.22', '5.0.1');

describe('isEusMinor', () => {
  it('is true for even minors from 4.6 and false for odd ones or anything below 4.6', () => {
    expect([6, 18, 20].map(isEusMinor)).toEqual([true, true, true]);
    expect([2, 4, 19, 21].map(isEusMinor)).toEqual([false, false, false, false]);
  });
});

describe('controlPlaneOnlyLegs', () => {
  it('splits a 4.14 -> 4.22 route into four EUS-to-EUS legs, one per two minors', () => {
    const legs = legsOf(
      route('4.14.50', '4.15.40', '4.16.33', '4.17.59', '4.18.59', '4.19.55', '4.20.46', '4.21.42', '4.22.22'),
    );
    expect(summary(legs)).toEqual([
      '4.14->4.16 pause@4.14.50 unpause@4.16.33',
      '4.16->4.18 pause@4.16.33 unpause@4.18.59',
      '4.18->4.20 pause@4.18.59 unpause@4.20.46',
      '4.20->4.22 pause@4.20.46 unpause@4.22.22',
    ]);
  });

  it('starts at the first EUS stream when the route enters at an odd minor (4.15)', () => {
    const legs = legsOf(route('4.15.40', '4.16.33', '4.17.59', '4.18.59'));
    expect(summary(legs)).toEqual(['4.16->4.18 pause@4.16.33 unpause@4.18.59']);
  });

  it('stops at 4.22 on a route into 5.0: the major boundary is never a leg', () => {
    expect(summary(legsOf(LIVE_416_TO_501))).toEqual([
      '4.16->4.18 pause@4.16.33 unpause@4.18.59',
      '4.18->4.20 pause@4.18.59 unpause@4.20.46',
      '4.20->4.22 pause@4.20.46 unpause@4.22.22',
    ]);
    expect(summary(legsOf(route('4.18.59', '4.19.55', '4.20.46', '4.21.42', '4.22.22', '5.0.1')))).toEqual([
      '4.18->4.20 pause@4.18.59 unpause@4.20.46',
      '4.20->4.22 pause@4.20.46 unpause@4.22.22',
    ]);
  });

  it('handles an odd start (4.17) by beginning at 4.18', () => {
    const legs = legsOf(route('4.17.59', '4.18.59', '4.19.55', '4.20.46', '4.21.42', '4.22.22'));
    expect(summary(legs)).toEqual(['4.18->4.20 pause@4.18.59 unpause@4.20.46', '4.20->4.22 pause@4.20.46 unpause@4.22.22']);
  });

  it('yields nothing for a route that crosses one minor or stays inside one', () => {
    expect(legsOf(route('4.18.2', '4.19.10'))).toEqual([]);
    expect(legsOf(route('4.18.2', '4.18.30'))).toEqual([]);
    expect(legsOf(route('4.18.2'))).toEqual([]);
    expect(legsOf([])).toEqual([]);
  });

  it('ignores a trailing half leg that ends on an odd minor', () => {
    const legs = legsOf(route('4.18.2', '4.19.10', '4.20.5', '4.21.3'));
    expect(summary(legs)).toEqual(['4.18->4.20 pause@4.18.2 unpause@4.20.5']);
  });

  it('pauses on the last version of the EUS stream and unpauses on the last version of the next one', () => {
    const [leg] = legsOf(route('4.16.10', '4.16.33', '4.17.5', '4.17.59', '4.18.2', '4.18.59', '4.19.4'));
    expect(leg).toMatchObject({ pauseAt: '4.16.33', unpauseAt: '4.18.59' });
    expect(available(leg).pausedHops.map((hop) => hop.to)).toEqual(['4.17.5', '4.17.59', '4.18.2', '4.18.59']);
  });

  it('never invents EUS rules below 4.6 or for a later major', () => {
    expect(legsOf(route('4.4.33', '4.5.40', '4.6.65'))).toEqual([]);
    expect(legsOf(route('5.6.0', '5.7.0', '5.8.0'))).toEqual([]);
    expect(summary(legsOf(route('4.6.1', '4.7.1', '4.8.1')))).toEqual(['4.6->4.8 pause@4.6.1 unpause@4.8.1']);
  });

  it('never keeps workers paused across more than one leg', () => {
    const versions = ['4.14.50', '4.15.40', '4.16.33', '4.17.59', '4.18.59', '4.19.55', '4.20.46', '4.21.42', '4.22.22', '5.0.1'] as Version[];
    const legs = legsOf(route(...versions));
    let previousUnpause = -1;
    for (const leg of legs.map(available)) {
      const pause = versions.indexOf(leg.pauseAt);
      const unpause = versions.indexOf(leg.unpauseAt);
      expect(pause).toBeGreaterThanOrEqual(previousUnpause);
      const minorsWhilePaused = new Set(versions.slice(pause, unpause + 1).map((v) => formatStream(streamOf(v))));
      expect(minorsWhilePaused.size).toBe(3);
      previousUnpause = unpause;
    }
  });

  it('is unavailable when any hop from the pause point to the unpause point came from a fast or candidate graph', () => {
    const from = (channel: string | undefined, hops: PathHop[], index: number) =>
      hops.map((hop, i) => (i === index ? { ...hop, sourceChannel: channel } : hop));
    const versions = ['4.16.10', '4.16.33', '4.17.59', '4.18.2', '4.18.59', '4.19.4'];
    // Hops: 0 is inside 4.16 before the pause, 1-3 run with workers paused, 4 leaves 4.18 after the unpause.
    expect(summary(legsOf(from('candidate-4.18', route(...versions), 0)))).toEqual(['4.16->4.18 pause@4.16.33 unpause@4.18.59']);
    expect(summary(legsOf(from('fast-4.19', route(...versions), 4)))).toEqual(['4.16->4.18 pause@4.16.33 unpause@4.18.59']);
    expect(summary(legsOf(from('candidate-4.18', route(...versions), 1)))).toEqual(['4.16->4.18 unavailable at 4.17.59 (notStable)']);
    // Hop 3 runs inside 4.18 after the cluster first reaches it: workers unpause at 4.18.2 and 4.18.59 is an ordinary update.
    expect(summary(legsOf(from('fast-4.18', route(...versions), 3)))).toEqual(['4.16->4.18 pause@4.16.33 unpause@4.18.2']);
    expect(summary(legsOf(from('eus-4.18', route(...versions), 2)))).toEqual(['4.16->4.18 pause@4.16.33 unpause@4.18.59']);
    expect(summary(legsOf(from(undefined, route(...versions), 2)))).toEqual(['4.16->4.18 unavailable at 4.18.2 (notStable)']);
  });

  it('unpauses at the last destination release reached over eus or stable hops when a later patch hop is from candidate', () => {
    // Shaped like live eus-4.14 -> 4.22.23: every hop into 4.22.22 is on eus-4.22, only 4.22.22 -> 4.22.23 is on candidate-4.22.
    const hops = route('4.20.46', '4.21.42', '4.22.22', '4.22.23').map((hop, i) => ({ ...hop, sourceChannel: i === 2 ? 'candidate-4.22' : 'eus-4.22' }));
    expect(summary(legsOf(hops))).toEqual(['4.20->4.22 pause@4.20.46 unpause@4.22.22']);
  });

  it("links each leg to the Control Plane Only docs of the leg's destination stream", () => {
    const urls = legsOf(LIVE_416_TO_501).map((leg) => leg.docsUrl);
    expect(urls).toEqual(
      ['4.18', '4.20', '4.22'].map(
        (s) =>
          `https://docs.redhat.com/en/documentation/openshift_container_platform/${s}/html/updating_clusters/performing-a-cluster-update#control-plane-only-update`,
      ),
    );
  });
});

describe('a leg is available only once its destination EUS channel publishes every paused hop', () => {
  // The stable-4.20 fixture's route 4.18.50 -> 4.19.40 -> 4.20.32: every hop is from stable-4.20.
  const stableHops = route('4.18.50', '4.19.40', '4.20.32').map((hop) => ({ ...hop, sourceChannel: 'stable-4.20' }));
  const stable420 = (() => {
    const parsed = parseRawGraph(loadFixture('stable-4.20.json'), { channel: 'stable-4.20', arch: 'amd64' });
    if (!parsed.ok) throw new Error('stable-4.20 fixture did not parse');
    return parsed.value;
  })();

  function legsWith(hops: readonly PathHop[], state: ReturnType<EusGraphLookup>) {
    const asked: string[] = [];
    const legs = controlPlaneOnlyLegs(hops, (channel) => {
      asked.push(channel);
      return state;
    });
    return { legs, asked: [...new Set(asked)] };
  }

  it('checks the leg against eus-4.(E+2) and shows it as checking until that graph loads', () => {
    const { legs, asked } = legsWith(stableHops, { kind: 'loading' });
    expect(summary(legs)).toEqual(['4.18->4.20 checking eus-4.20']);
    expect(asked).toEqual(['eus-4.20']);
    expect(eusChannelsToCheck(stableHops)).toEqual(['eus-4.20']);
  });

  it('is unavailable when eus-4.(E+2) lacks a hop the route takes with workers paused, though stable has it', () => {
    const { legs } = legsWith(stableHops, { kind: 'loaded', graph: graphOf(stableHops.slice(0, 1)) });
    expect(summary(legs)).toEqual(['4.18->4.20 unavailable at 4.20.32 (notOnEus)']);
  });

  it('is unavailable when eus-4.(E+2) fails to load or has no releases', () => {
    expect(summary(legsWith(stableHops, { kind: 'failed', error: { kind: 'network', message: 'Bad Gateway', status: 502 } }).legs)).toEqual([
      '4.18->4.20 unavailable: eus-4.20 network',
    ]);
    expect(summary(legsWith(stableHops, { kind: 'failed', error: { kind: 'empty', channel: 'eus-4.20', arch: 'amd64' } }).legs)).toEqual([
      '4.18->4.20 unavailable: eus-4.20 empty',
    ]);
  });

  it('is available, verified on eus-4.(E+2), when that graph publishes every paused hop', () => {
    const { legs } = legsWith(stableHops, { kind: 'loaded', graph: stable420 });
    expect(summary(legs)).toEqual(['4.18->4.20 pause@4.18.50 unpause@4.20.32']);
    expect(available(legs[0]).eusChannel).toBe('eus-4.20');
  });

  it('never consults the EUS graph for a leg a fast or candidate hop already rules out', () => {
    const hops = stableHops.map((hop, i) => (i === 1 ? { ...hop, sourceChannel: 'fast-4.20' } : hop));
    const { legs, asked } = legsWith(hops, { kind: 'loading' });
    expect(summary(legs)).toEqual(['4.18->4.20 unavailable at 4.20.32 (notStable)']);
    expect(asked).toEqual([]);
    expect(eusChannelsToCheck(hops)).toEqual([]);
  });

  it('keeps workers paused into later destination patches only while eus-4.(E+2) publishes them', () => {
    const hops = route('4.18.50', '4.19.40', '4.20.32', '4.20.33').map((hop) => ({ ...hop, sourceChannel: 'stable-4.20' }));
    expect(summary(legsWith(hops, { kind: 'loaded', graph: graphOf(hops.slice(0, 2)) }).legs)).toEqual(['4.18->4.20 pause@4.18.50 unpause@4.20.32']);
    expect(summary(legsWith(hops, { kind: 'loaded', graph: graphOf(hops) }).legs)).toEqual(['4.18->4.20 pause@4.18.50 unpause@4.20.33']);
  });

  it('lists one EUS channel per leg to check', () => {
    expect(eusChannelsToCheck(LIVE_416_TO_501)).toEqual(['eus-4.18', 'eus-4.20', 'eus-4.22']);
  });
});

describe('legSteps', () => {
  const [leg] = legsOf(LIVE_416_TO_501);
  const steps = legSteps(available(leg));
  const digest = (i: number) => `quay.io/openshift-release-dev/ocp-release@sha256:${String(i).padStart(64, '0')}`;

  it("follows Red Hat's CLI procedure: pools settled, switch and pause, the paused updates on eus-4.(E+2), unpause, pools settled", () => {
    expect(steps.map((step) => (step.kind === 'update' ? `update ${step.hop.to}` : step.kind))).toEqual([
      'checkPools',
      'pause',
      'update 4.17.59',
      'update 4.18.59',
      'unpause',
      'waitForPools',
      'returnChannel',
    ]);
  });

  it('confirms the pools before the pause, and pauses only once the switch to eus-4.(E+2) succeeds', () => {
    const [checkPools, pause] = steps;
    expect(checkPools).toMatchObject({ kind: 'checkPools', commands: ['oc get mcp'] });
    expect(checkPools?.kind === 'checkPools' && checkPools.when).toMatch(/^At 4\.16\.33, before the update to 4\.17\.59.*UPDATED=True and UPDATING=False/);
    expect(pause).toMatchObject({
      kind: 'pause',
      commands: [`oc adm upgrade channel eus-4.18 && oc patch mcp/worker --type merge --patch '{"spec":{"paused":true}}'`],
    });
  });

  it("runs each paused update on eus-4.(E+2), with that graph's payload", () => {
    const updates = steps.filter((step) => step.kind === 'update');
    expect(updates.map((step) => [step.upgradeTo, step.upgradeToImage])).toEqual([
      ['oc adm upgrade --to 4.17.59', `oc adm upgrade --to-image=${digest(1)} --allow-explicit-upgrade`],
      ['oc adm upgrade --to 4.18.59', `oc adm upgrade --to-image=${digest(2)} --allow-explicit-upgrade`],
    ]);
  });

  it('unpauses once the cluster reports the last release reached with workers paused', () => {
    expect(steps.find((step) => step.kind === 'unpause')).toEqual({
      kind: 'unpause',
      when: 'Once the cluster reports 4.18.59',
      commands: [`oc patch mcp/worker --type merge --patch '{"spec":{"paused":false}}'`],
    });
  });

  it('waits for every paused pool before the next update of any kind, a patch in the same minor included', () => {
    expect(steps.find((step) => step.kind === 'waitForPools')).toEqual({
      kind: 'waitForPools',
      when: 'Before the next update of any kind, including a patch update within 4.18, wait until every pool you paused reports UPDATED=True and UPDATING=False',
      commands: ['oc get mcp'],
    });
  });

  it("returns to the channel the main route's next update runs on", () => {
    expect(steps.at(-1)).toEqual({
      kind: 'returnChannel',
      when: 'Then return to stable-4.22, the channel the main route takes its next update (4.18.59 → 4.19.55) on',
      commands: ['oc adm upgrade channel stable-4.22'],
    });
  });

  it('has nothing to return to when the leg ends the route', () => {
    const [last] = legsOf(route('4.16.33', '4.17.59', '4.18.59'));
    expect(legSteps(available(last)).at(-1)?.kind).toBe('waitForPools');
  });
});

describe('the risks eus-4.(E+2) attaches to a paused update', () => {
  const always = { url: 'https://example.com/A', name: 'EusOnly', message: '', matchingRules: [{ type: 'Always' as const }] };
  const promql = (name: string) => ({ url: `https://example.com/${name}`, name, message: '', matchingRules: [{ type: 'PromQL' as const, promql: 'up' }] });

  function eusGraphWithRisks(hops: readonly PathHop[], risks: readonly Risk[]): Graph {
    const graph = graphOf(hops);
    const { from, to } = hops[1] as PathHop;
    return { ...graph, conditionalEdges: [{ edges: [{ from, to }], risks }] };
  }

  it("lists eus-4.(E+2)'s own risks for the hop, and names each that differs from the route channel's", () => {
    const hops = route('4.18.50', '4.19.40', '4.20.32').map((hop, i) => (i === 1 ? { ...hop, risks: [promql('Shared'), promql('StableOnly')] } : hop));
    const graph = eusGraphWithRisks(hops, [promql('Shared'), always]);
    const [leg] = controlPlaneOnlyLegs(hops, () => ({ kind: 'loaded', graph }));
    const update = legSteps(available(leg)).filter((step) => step.kind === 'update')[1];

    expect(update?.hop.risks.map((risk) => risk.name)).toEqual(['Shared', 'EusOnly']);
    expect(update?.riskNotes).toEqual([
      'eus-4.20 attaches EusOnly (Always) to 4.19.40 → 4.20.32, which stable-4.22 does not.',
      'stable-4.22 attaches StableOnly (conditional) to 4.19.40 → 4.20.32, which eus-4.20 does not.',
    ]);
  });
});

