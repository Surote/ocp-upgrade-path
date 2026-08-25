import { describe, expect, it } from 'vitest';
import { candidateChannelsForMinor } from '../forwardChannel';

describe('candidateChannelsForMinor', () => {
  it('offers the same class first, then a stable fallback, for a non-stable preferred class', () => {
    expect(candidateChannelsForMinor('eus', 22)).toEqual(['eus-4.22', 'stable-4.22']);
    expect(candidateChannelsForMinor('fast', 21)).toEqual(['fast-4.21', 'stable-4.21']);
    expect(candidateChannelsForMinor('candidate', 9)).toEqual(['candidate-4.9', 'stable-4.9']);
  });

  it('offers only stable itself when the preferred class already is stable -- no point falling back to itself', () => {
    expect(candidateChannelsForMinor('stable', 21)).toEqual(['stable-4.21']);
  });
});
