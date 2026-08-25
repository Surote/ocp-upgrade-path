import { describe, expect, it } from 'vitest';
import { sortChannels } from '../sortChannels';

describe('sortChannels', () => {
  it('sorts by minor descending, never lexically -- 4.9 would wrongly land after 4.18 as strings', () => {
    const result = sortChannels(['stable-4.9', 'stable-4.18', 'stable-4.2']);
    expect(result).toEqual(['stable-4.18', 'stable-4.9', 'stable-4.2']);
  });

  it('within the same minor, orders classes stable, eus, fast, candidate', () => {
    const result = sortChannels(['candidate-4.20', 'fast-4.20', 'stable-4.20', 'eus-4.20']);
    expect(result).toEqual(['stable-4.20', 'eus-4.20', 'fast-4.20', 'candidate-4.20']);
  });

  it('matches the real 18-channel set from the stable-4.20 fixture (candidate/fast/stable 4.18-4.22, eus 4.18/4.20/4.22)', () => {
    const names = [
      'candidate-4.18', 'candidate-4.19', 'candidate-4.20', 'candidate-4.21', 'candidate-4.22',
      'eus-4.18', 'eus-4.20', 'eus-4.22',
      'fast-4.18', 'fast-4.19', 'fast-4.20', 'fast-4.21', 'fast-4.22',
      'stable-4.18', 'stable-4.19', 'stable-4.20', 'stable-4.21', 'stable-4.22',
    ];
    const result = sortChannels(names);
    expect(result).toEqual([
      'stable-4.22', 'eus-4.22', 'fast-4.22', 'candidate-4.22',
      'stable-4.21', 'fast-4.21', 'candidate-4.21',
      'stable-4.20', 'eus-4.20', 'fast-4.20', 'candidate-4.20',
      'stable-4.19', 'fast-4.19', 'candidate-4.19',
      'stable-4.18', 'eus-4.18', 'fast-4.18', 'candidate-4.18',
    ]);
  });

  it('places an unrecognised channel-name shape after every recognised one, without crashing', () => {
    const result = sortChannels(['stable-4.18', 'some-weird-channel', 'candidate-4.18']);
    expect(result).toEqual(['stable-4.18', 'candidate-4.18', 'some-weird-channel']);
  });

  it('handles an empty list', () => {
    expect(sortChannels([])).toEqual([]);
  });

  it('is stable/idempotent for an already-sorted list', () => {
    const sorted = sortChannels(['stable-4.20', 'eus-4.20']);
    expect(sortChannels(sorted)).toEqual(sorted);
  });
});
