import { describe, expect, it } from 'vitest';
import { candidateChannelsForStream } from '../forwardChannel';

describe('candidateChannelsForStream', () => {
  it('offers the preferred class first, then a stable fallback', () => {
    expect(candidateChannelsForStream('eus', { major: 4, minor: 22 })).toEqual(['eus-4.22', 'stable-4.22']);
  });

  it('does not repeat stable when it is already the preferred class', () => {
    expect(candidateChannelsForStream('stable', { major: 4, minor: 21 })).toEqual(['stable-4.21']);
  });

  it('names channels in the stream of a new major', () => {
    expect(candidateChannelsForStream('stable', { major: 5, minor: 0 })).toEqual(['stable-5.0']);
  });
});
