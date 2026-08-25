import { describe, expect, it } from 'vitest';
import type { Version } from '../../graph/types';
import { evaluateEusAdvisory, isEusMinor } from '../eus';

describe('isEusMinor', () => {
  it('is true for even minors and false for odd ones', () => {
    expect(isEusMinor(18)).toBe(true);
    expect(isEusMinor(20)).toBe(true);
    expect(isEusMinor(19)).toBe(false);
    expect(isEusMinor(21)).toBe(false);
  });
});

describe('evaluateEusAdvisory', () => {
  it('applies for a canonical EUS-to-EUS jump (4.18 -> 4.20)', () => {
    const result = evaluateEusAdvisory('4.18.2' as Version, '4.20.32' as Version);
    expect(result).toEqual({ applies: true, startMinor: 18, targetMinor: 20 });
  });

  it('applies across a wider EUS-to-EUS jump (4.16 -> 4.20)', () => {
    expect(evaluateEusAdvisory('4.16.1' as Version, '4.20.1' as Version).applies).toBe(true);
  });

  it('does not apply when only one minor is crossed, even between EUS minors that are adjacent by name', () => {
    // 4.18 -> 4.19 crosses one minor and 4.19 isn't EUS anyway, but this
    // also guards the "< 2 minors crossed" branch directly.
    expect(evaluateEusAdvisory('4.18.2' as Version, '4.19.10' as Version).applies).toBe(false);
  });

  it('does not apply when start or target is not an EUS (even) minor', () => {
    expect(evaluateEusAdvisory('4.17.0' as Version, '4.21.0' as Version).applies).toBe(false);
    expect(evaluateEusAdvisory('4.18.0' as Version, '4.21.0' as Version).applies).toBe(false);
    expect(evaluateEusAdvisory('4.19.0' as Version, '4.20.0' as Version).applies).toBe(false);
  });

  it('does not apply below 4.6, where EUS channels do not exist despite even parity', () => {
    // Verified live: eus-4.1 .. eus-4.5 all return an empty graph; eus-4.6 has
    // 52 nodes. Parity alone would wrongly fire this advisory on a 4.4 -> 4.6
    // plan, which the UI can genuinely construct (stable-4.4 has 53 nodes).
    expect(isEusMinor(2)).toBe(false);
    expect(isEusMinor(4)).toBe(false);
    expect(isEusMinor(6)).toBe(true);
    expect(evaluateEusAdvisory('4.4.33' as Version, '4.6.65' as Version).applies).toBe(false);
    expect(evaluateEusAdvisory('4.2.0' as Version, '4.4.0' as Version).applies).toBe(false);
  });

  it('still applies from 4.6 upward', () => {
    expect(evaluateEusAdvisory('4.6.1' as Version, '4.8.1' as Version).applies).toBe(true);
  });

  it('does not apply when start equals target', () => {
    expect(evaluateEusAdvisory('4.18.2' as Version, '4.18.2' as Version).applies).toBe(false);
  });
});
