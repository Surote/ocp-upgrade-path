import { describe, expect, it } from 'vitest';
import type { Version } from '../../graph/types';
import { loadFixture } from '../../test-utils/fixtures';
import { compareVersions, parseVersion } from '../version';

function v(s: string): Version {
  return s as Version;
}

describe('parseVersion', () => {
  it('parses a plain release version', () => {
    expect(parseVersion(v('4.18.49'))).toEqual({ major: 4, minor: 18, patch: 49, prerelease: [] });
  });

  it('parses a prerelease version, splitting the identifier on dots', () => {
    expect(parseVersion(v('4.18.0-rc.10'))).toEqual({ major: 4, minor: 18, patch: 0, prerelease: ['rc', '10'] });
  });

  it('throws on a string outside the X.Y.Z[-prerelease] grammar', () => {
    expect(() => parseVersion(v('not-a-version'))).toThrow();
    expect(() => parseVersion(v('4.18'))).toThrow();
  });
});

describe('compareVersions — numeric components', () => {
  it('orders by major, then minor, then patch, numerically', () => {
    expect(compareVersions(v('4.18.2'), v('4.18.49'))).toBeLessThan(0);
    expect(compareVersions(v('4.9.0'), v('4.10.0'))).toBeLessThan(0); // numeric, not lexical (10 vs 9)
    expect(compareVersions(v('4.20.1'), v('4.19.99'))).toBeGreaterThan(0);
    expect(compareVersions(v('4.18.2'), v('4.18.2'))).toBe(0);
  });
});

describe('compareVersions — prerelease ordering (semver §11)', () => {
  it('rc.10 sorts after rc.9 -- numeric identifier comparison, not lexical', () => {
    expect(compareVersions(v('4.18.0-rc.9'), v('4.18.0-rc.10'))).toBeLessThan(0);
    // A naive string/lexical sort would get this backwards ("10" < "9" lexically).
    expect('4.18.0-rc.10'.localeCompare('4.18.0-rc.9')).toBeLessThan(0);
  });

  it('a prerelease sorts before its release', () => {
    expect(compareVersions(v('4.18.0-rc.10'), v('4.18.0'))).toBeLessThan(0);
    expect(compareVersions(v('4.19.0-rc.5'), v('4.19.0'))).toBeLessThan(0); // 4.19.0 exists in the candidate-4.20 fixture
  });

  it('ec sorts before rc via ordinary alphanumeric identifier comparison, with no special-casing', () => {
    expect(compareVersions(v('4.18.0-ec.4'), v('4.18.0-rc.0'))).toBeLessThan(0);
  });

  it('a shorter prerelease identifier list that is a prefix of a longer one sorts lower', () => {
    expect(compareVersions(v('4.18.0-rc'), v('4.18.0-rc.1'))).toBeLessThan(0);
  });

  it('is a strict total order: sorting is transitive and antisymmetric', () => {
    const versions = [v('4.18.0-rc.2'), v('4.18.0-rc.10'), v('4.18.0-ec.0'), v('4.18.0'), v('4.18.0-rc.1')];
    const sorted = [...versions].sort(compareVersions);
    expect(sorted).toEqual([v('4.18.0-ec.0'), v('4.18.0-rc.1'), v('4.18.0-rc.2'), v('4.18.0-rc.10'), v('4.18.0')]);
  });
});

describe('compareVersions — against the real prerelease sets in the fixtures', () => {
  it('sorts every prerelease version pulled from candidate-4.20.json into strictly increasing order per minor', () => {
    const raw = loadFixture('candidate-4.20.json') as { nodes: { version: string }[] };
    const prereleases = raw.nodes.map((n) => n.version).filter((ver) => ver.includes('-'));
    expect(prereleases.length).toBe(38); // pinned count from the fixture, per the task brief

    const byMinor = new Map<number, Version[]>();
    for (const ver of prereleases) {
      const minor = parseVersion(v(ver)).minor;
      const list = byMinor.get(minor) ?? [];
      list.push(v(ver));
      byMinor.set(minor, list);
    }

    for (const [, versions] of byMinor) {
      const sorted = [...versions].sort(compareVersions);
      for (let i = 1; i < sorted.length; i += 1) {
        expect(compareVersions(sorted[i - 1] as Version, sorted[i] as Version)).toBeLessThan(0);
      }
    }

    // Spot-check the specific ordering the task brief calls out explicitly.
    expect(compareVersions(v('4.18.0-rc.9'), v('4.18.0-rc.10'))).toBeLessThan(0);
    expect(compareVersions(v('4.19.0-ec.3'), v('4.19.0-ec.4'))).toBeLessThan(0);
    expect(compareVersions(v('4.20.0-ec.6'), v('4.20.0-rc.0'))).toBeLessThan(0);
  });
});
