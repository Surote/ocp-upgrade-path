import { describe, expect, it } from 'vitest';
import type { Version } from '../../graph/types';
import { adminAckKeysFor, buildAdminAckCommand, kcsLinkFor, minorsEntered } from '../adminAcks';

describe('adminAckKeysFor', () => {
  it('returns both keys for 4.19, which needs two', () => {
    expect(adminAckKeysFor(19)).toEqual(['ack-4.18-gateway-api-management-in-4.19', 'ack-4.18-kube-1.32-api-removals-in-4.19']);
  });

  it('returns the single verified key for 4.14, 4.16, 4.20 and 4.22', () => {
    expect(adminAckKeysFor(14)).toEqual(['ack-4.13-kube-1.27-api-removals-in-4.14']);
    expect(adminAckKeysFor(16)).toEqual(['ack-4.15-kube-1.29-api-removals-in-4.16']);
    expect(adminAckKeysFor(20)).toEqual(['ack-4.19-admissionregistration-v1beta1-api-removals-in-4.20']);
    expect(adminAckKeysFor(22)).toEqual(['ack-4.21-boot-image-opt-out-in-4.22']);
  });

  it('returns empty for minors verified to need none (4.17, 4.18, 4.21)', () => {
    expect(adminAckKeysFor(17)).toEqual([]);
    expect(adminAckKeysFor(18)).toEqual([]);
    expect(adminAckKeysFor(21)).toEqual([]);
  });

  it('returns empty -- never a synthesised guess -- for a minor never checked at all', () => {
    // 4.25 is not in the table at all (unlike 4.17/4.18/4.21, which were
    // checked and found to have none). Both must come back empty, identically,
    // rather than the unknown case fabricating a `ack-4.24-...-in-4.25` guess.
    expect(adminAckKeysFor(25)).toEqual([]);
    expect(adminAckKeysFor(99)).toEqual([]);
  });

  it('never returns a key that was not read verbatim off a real docs page', () => {
    // Guards against a future regression where someone "helpfully" derives
    // ack-4.<n-1>-...-in-4.<n> from a template for a minor not in the table.
    for (const minor of [11, 15, 17, 18, 21, 23, 24]) {
      expect(adminAckKeysFor(minor)).toEqual([]);
    }
  });
});

describe('kcsLinkFor', () => {
  it('links the verified article id directly for a known minor', () => {
    expect(kcsLinkFor(20)).toEqual({ url: 'https://access.redhat.com/articles/7130599', isSearch: false });
    expect(kcsLinkFor(19)).toEqual({ url: 'https://access.redhat.com/articles/7112216', isSearch: false });
  });

  it('falls back to a KCS search, never a guessed article id, for an unverified minor', () => {
    const link = kcsLinkFor(21);
    expect(link.isSearch).toBe(true);
    expect(link.url).toBe('https://access.redhat.com/search/?q=Preparing+to+upgrade+to+OpenShift+Container+Platform+4.21');
  });
});

describe('minorsEntered', () => {
  it('lists distinct minors after the start, in traversal order', () => {
    const versions = ['4.18.2', '4.18.50', '4.19.40', '4.20.32'] as Version[];
    expect(minorsEntered(versions)).toEqual([19, 20]);
  });

  it('names every minor on a longer stitched path, including intermediate ones', () => {
    const versions = ['4.18.2', '4.18.51', '4.19.41', '4.20.33', '4.21.28', '4.22.9'] as Version[];
    expect(minorsEntered(versions)).toEqual([19, 20, 21, 22]);
  });

  it('returns empty for a pure patch-level bump that never leaves the start minor', () => {
    const versions = ['4.18.2', '4.18.50'] as Version[];
    expect(minorsEntered(versions)).toEqual([]);
  });

  it('returns empty for an empty path', () => {
    expect(minorsEntered([])).toEqual([]);
  });
});

describe('buildAdminAckCommand', () => {
  it('renders a single-key patch matching the verbatim 4.20 docs shape', () => {
    const cmd = buildAdminAckCommand(['ack-4.19-admissionregistration-v1beta1-api-removals-in-4.20']);
    expect(cmd).toContain('oc -n openshift-config patch cm admin-acks');
    expect(cmd).toContain('"data":{"ack-4.19-admissionregistration-v1beta1-api-removals-in-4.20":"true"}');
    expect(cmd).toContain('--type=merge');
  });

  it('renders both keys in one patch for the 4.19 two-key case', () => {
    const cmd = buildAdminAckCommand(['ack-4.18-gateway-api-management-in-4.19', 'ack-4.18-kube-1.32-api-removals-in-4.19']);
    expect(cmd).toContain('"ack-4.18-gateway-api-management-in-4.19":"true"');
    expect(cmd).toContain('"ack-4.18-kube-1.32-api-removals-in-4.19":"true"');
  });
});
