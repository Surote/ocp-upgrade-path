import { describe, expect, it } from 'vitest';
import type { Version } from '../../graph/types';
import { LANE_COUNT, laneClassName, laneIndexForMinor, laneIndexForVersion } from '../lanes';

describe('laneIndexForMinor', () => {
  it('is deterministic: the same minor always yields the same index', () => {
    expect(laneIndexForMinor(19)).toBe(laneIndexForMinor(19));
    expect(laneIndexForMinor(19)).toBe(laneIndexForMinor(19));
  });

  it('stays within [0, LANE_COUNT) for typical, negative and large minors', () => {
    for (const minor of [0, 1, 17, 18, 19, 20, 21, 100, -1, -5]) {
      const idx = laneIndexForMinor(minor);
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThan(LANE_COUNT);
    }
  });

  it('gives adjacent real-world minors distinct lanes', () => {
    const indices = [18, 19, 20, 21].map(laneIndexForMinor);
    expect(new Set(indices).size).toBe(4);
  });

  it('wraps around after LANE_COUNT minors', () => {
    expect(laneIndexForMinor(18)).toBe(laneIndexForMinor(18 + LANE_COUNT));
  });
});

describe('laneIndexForVersion', () => {
  it('derives the lane from the version string minor component', () => {
    expect(laneIndexForVersion('4.19.40' as Version)).toBe(laneIndexForMinor(19));
    expect(laneIndexForVersion('4.20.32' as Version)).toBe(laneIndexForMinor(20));
  });
});

describe('laneClassName', () => {
  it('produces a stable, minor-derived class name', () => {
    expect(laneClassName(19)).toBe(`lane-${laneIndexForMinor(19)}`);
    expect(laneClassName(19)).toBe(laneClassName(19));
  });
});
