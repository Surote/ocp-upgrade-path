import { describe, expect, it } from 'vitest';
import type { GraphNode, Version } from '../../graph/types';
import { channelClassOf, channelMinorOf, channelNamesForNode } from '../channels';

describe('channelClassOf', () => {
  it('extracts the class prefix from a well-formed channel name', () => {
    expect(channelClassOf('stable-4.20')).toBe('stable');
    expect(channelClassOf('eus-4.18')).toBe('eus');
    expect(channelClassOf('candidate-4.9')).toBe('candidate');
  });

  it('returns undefined for a name that does not match the convention', () => {
    expect(channelClassOf('not-a-channel')).toBeUndefined();
    expect(channelClassOf('')).toBeUndefined();
  });
});

describe('channelMinorOf', () => {
  it('extracts the minor number from a well-formed channel name', () => {
    expect(channelMinorOf('stable-4.20')).toBe(20);
    expect(channelMinorOf('eus-4.18')).toBe(18);
    expect(channelMinorOf('fast-4.9')).toBe(9);
  });

  it('returns undefined for a name that does not match the convention', () => {
    expect(channelMinorOf('not-a-channel')).toBeUndefined();
    expect(channelMinorOf('')).toBeUndefined();
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
