import { describe, expect, it } from 'vitest';
import type { GraphNode, Version } from '../../graph/types';
import { channelNamesForNode, formatChannelName, parseChannelName } from '../channels';

describe('parseChannelName', () => {
  it('parses class, major and minor from a 4.x name', () => {
    expect(parseChannelName('stable-4.20')).toEqual({ cls: 'stable', major: 4, minor: 20 });
    expect(parseChannelName('fast-4.9')).toEqual({ cls: 'fast', major: 4, minor: 9 });
  });

  it('parses names in a later major', () => {
    expect(parseChannelName('candidate-5.0')).toEqual({ cls: 'candidate', major: 5, minor: 0 });
    expect(parseChannelName('eus-5.12')).toEqual({ cls: 'eus', major: 5, minor: 12 });
  });

  it('returns undefined for a name that does not match the convention', () => {
    expect(parseChannelName('not-a-channel')).toBeUndefined();
    expect(parseChannelName('stable-5')).toBeUndefined();
    expect(parseChannelName('')).toBeUndefined();
  });
});

describe('formatChannelName', () => {
  it('round-trips a parsed name', () => {
    for (const name of ['stable-4.22', 'candidate-5.0', 'eus-4.6']) {
      const parsed = parseChannelName(name);
      expect(parsed && formatChannelName(parsed)).toBe(name);
    }
  });
});

describe('channelNamesForNode', () => {
  const node: GraphNode = {
    version: '4.18.2' as Version,
    payload: 'quay.io/openshift-release-dev/ocp-release@sha256:abc',
    channels: [0, 2, 5],
  };

  it('resolves in-range indices to names', () => {
    expect(channelNamesForNode(node, ['stable-4.18', 'fast-4.18', 'eus-4.18'])).toEqual(['stable-4.18', 'eus-4.18']);
  });

  it('drops out-of-range indices instead of mislabeling them', () => {
    expect(channelNamesForNode(node, ['stable-4.18'])).toEqual(['stable-4.18']);
  });

  it('returns an empty list for an undefined node', () => {
    expect(channelNamesForNode(undefined, ['stable-4.18'])).toEqual([]);
  });

  it('returns an empty list when the node has no channel membership', () => {
    expect(channelNamesForNode({ ...node, channels: [] }, ['stable-4.18'])).toEqual([]);
  });
});
