import { describe, expect, it } from 'vitest';
import type { PathHop } from '../../engine/types';
import { formatStream, streamOf } from '../../engine/version';
import type { Version } from '../../graph/types';
import { type AvailableLeg, buildLegScript, controlPlaneOnlyLegs, isEusMinor, type ControlPlaneOnlyLeg } from '../eus';

/** A route's hops, each taken from a stable channel's graph. */
function route(...vs: string[]): PathHop[] {
  return vs.slice(1).map((to, i) => ({ from: vs[i] as Version, to: to as Version, risks: [], sourceChannel: 'stable-4.22' }));
}

function summary(legs: readonly ControlPlaneOnlyLeg[]) {
  return legs.map(
    (leg) =>
      `${formatStream(leg.from)}->${formatStream(leg.to)} ${
        leg.kind === 'available' ? `pause@${leg.pauseAt} unpause@${leg.unpauseAt}` : `unavailable at ${leg.blockingHop.to}`
      }`,
  );
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
    const legs = controlPlaneOnlyLegs(
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
    const legs = controlPlaneOnlyLegs(route('4.15.40', '4.16.33', '4.17.59', '4.18.59'));
    expect(summary(legs)).toEqual(['4.16->4.18 pause@4.16.33 unpause@4.18.59']);
  });

  it('stops at 4.22 on a route into 5.0: the major boundary is never a leg', () => {
    expect(summary(controlPlaneOnlyLegs(LIVE_416_TO_501))).toEqual([
      '4.16->4.18 pause@4.16.33 unpause@4.18.59',
      '4.18->4.20 pause@4.18.59 unpause@4.20.46',
      '4.20->4.22 pause@4.20.46 unpause@4.22.22',
    ]);
    expect(summary(controlPlaneOnlyLegs(route('4.18.59', '4.19.55', '4.20.46', '4.21.42', '4.22.22', '5.0.1')))).toEqual([
      '4.18->4.20 pause@4.18.59 unpause@4.20.46',
      '4.20->4.22 pause@4.20.46 unpause@4.22.22',
    ]);
  });

  it('handles an odd start (4.17) by beginning at 4.18', () => {
    const legs = controlPlaneOnlyLegs(route('4.17.59', '4.18.59', '4.19.55', '4.20.46', '4.21.42', '4.22.22'));
    expect(summary(legs)).toEqual(['4.18->4.20 pause@4.18.59 unpause@4.20.46', '4.20->4.22 pause@4.20.46 unpause@4.22.22']);
  });

  it('yields nothing for a route that crosses one minor or stays inside one', () => {
    expect(controlPlaneOnlyLegs(route('4.18.2', '4.19.10'))).toEqual([]);
    expect(controlPlaneOnlyLegs(route('4.18.2', '4.18.30'))).toEqual([]);
    expect(controlPlaneOnlyLegs(route('4.18.2'))).toEqual([]);
    expect(controlPlaneOnlyLegs([])).toEqual([]);
  });

  it('ignores a trailing half leg that ends on an odd minor', () => {
    const legs = controlPlaneOnlyLegs(route('4.18.2', '4.19.10', '4.20.5', '4.21.3'));
    expect(summary(legs)).toEqual(['4.18->4.20 pause@4.18.2 unpause@4.20.5']);
  });

  it('pauses on the last version of the EUS stream and unpauses on the last version of the next one', () => {
    const [leg] = controlPlaneOnlyLegs(route('4.16.10', '4.16.33', '4.17.5', '4.17.59', '4.18.2', '4.18.59', '4.19.4'));
    expect(leg).toMatchObject({ pauseAt: '4.16.33', firstPausedHopTo: '4.17.5', unpauseAt: '4.18.59' });
  });

  it('never invents EUS rules below 4.6 or for a later major', () => {
    expect(controlPlaneOnlyLegs(route('4.4.33', '4.5.40', '4.6.65'))).toEqual([]);
    expect(controlPlaneOnlyLegs(route('5.6.0', '5.7.0', '5.8.0'))).toEqual([]);
    expect(summary(controlPlaneOnlyLegs(route('4.6.1', '4.7.1', '4.8.1')))).toEqual(['4.6->4.8 pause@4.6.1 unpause@4.8.1']);
  });

  it('never keeps workers paused across more than one leg', () => {
    const versions = ['4.14.50', '4.15.40', '4.16.33', '4.17.59', '4.18.59', '4.19.55', '4.20.46', '4.21.42', '4.22.22', '5.0.1'] as Version[];
    const legs = controlPlaneOnlyLegs(route(...versions));
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
    expect(summary(controlPlaneOnlyLegs(from('candidate-4.18', route(...versions), 0)))).toEqual(['4.16->4.18 pause@4.16.33 unpause@4.18.59']);
    expect(summary(controlPlaneOnlyLegs(from('fast-4.19', route(...versions), 4)))).toEqual(['4.16->4.18 pause@4.16.33 unpause@4.18.59']);
    expect(summary(controlPlaneOnlyLegs(from('candidate-4.18', route(...versions), 1)))).toEqual(['4.16->4.18 unavailable at 4.17.59']);
    expect(summary(controlPlaneOnlyLegs(from('fast-4.18', route(...versions), 3)))).toEqual(['4.16->4.18 unavailable at 4.18.59']);
    expect(summary(controlPlaneOnlyLegs(from('eus-4.18', route(...versions), 2)))).toEqual(['4.16->4.18 pause@4.16.33 unpause@4.18.59']);
    expect(summary(controlPlaneOnlyLegs(from(undefined, route(...versions), 2)))).toEqual(['4.16->4.18 unavailable at 4.18.2']);
  });

  it("links each leg to the Control Plane Only docs of the leg's destination stream", () => {
    const urls = controlPlaneOnlyLegs(LIVE_416_TO_501).map((leg) => leg.docsUrl);
    expect(urls).toEqual(
      ['4.18', '4.20', '4.22'].map(
        (s) =>
          `https://docs.redhat.com/en/documentation/openshift_container_platform/${s}/html/updating_clusters/performing-a-cluster-update#control-plane-only-update`,
      ),
    );
  });
});

describe('buildLegScript', () => {
  it('places the pause before the first hop into the odd minor and the unpause plus pool check at the even minor', () => {
    expect(buildLegScript(available(controlPlaneOnlyLegs(LIVE_416_TO_501)[0]))).toBe(
      [
        '# at 4.16.33, before: oc adm upgrade --to 4.17.59',
        `oc patch mcp/worker --type merge --patch '{"spec":{"paused":true}}'`,
        '# once the cluster reports 4.18.59',
        `oc patch mcp/worker --type merge --patch '{"spec":{"paused":false}}'`,
        'oc get mcp  # wait for worker UPDATED=True before leaving 4.18',
      ].join('\n'),
    );
  });
});
