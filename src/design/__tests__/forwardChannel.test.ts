import { describe, expect, it } from 'vitest';
import { candidateChannelsForStream } from '../forwardChannel';

describe('candidateChannelsForStream', () => {
  it('offers the preferred class first, then stable, fast, candidate', () => {
    expect(candidateChannelsForStream('eus', { major: 4, minor: 22 })).toEqual(['eus-4.22', 'stable-4.22', 'fast-4.22', 'candidate-4.22']);
  });

  it('does not repeat the preferred class in the fallback tail', () => {
    expect(candidateChannelsForStream('stable', { major: 4, minor: 21 })).toEqual(['stable-4.21', 'fast-4.21', 'candidate-4.21']);
    expect(candidateChannelsForStream('fast', { major: 4, minor: 21 })).toEqual(['fast-4.21', 'stable-4.21', 'candidate-4.21']);
  });

  it('names channels in the stream of a new major', () => {
    expect(candidateChannelsForStream('stable', { major: 5, minor: 0 })).toEqual(['stable-5.0', 'fast-5.0', 'candidate-5.0']);
  });
});
