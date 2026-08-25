import { describe, expect, it, vi } from 'vitest';
import { parseUrlState, resolveUrlArch, serializeUrlState, syncUrlState } from '../urlState';

describe('parseUrlState', () => {
  it('parses all four params', () => {
    expect(parseUrlState('?channel=stable-4.20&arch=amd64&start=4.18.2&target=4.20.32')).toEqual({
      channel: 'stable-4.20',
      arch: 'amd64',
      start: '4.18.2',
      target: '4.20.32',
    });
  });

  it('works without a leading "?"', () => {
    expect(parseUrlState('channel=stable-4.20')).toEqual({ channel: 'stable-4.20', arch: undefined, start: undefined, target: undefined });
  });

  it('returns an all-undefined state for an empty query string', () => {
    expect(parseUrlState('')).toEqual({ channel: undefined, arch: undefined, start: undefined, target: undefined });
  });

  it('treats a present-but-empty param as unset, not an empty string', () => {
    expect(parseUrlState('?channel=&start=4.18.2')).toEqual({ channel: undefined, arch: undefined, start: '4.18.2', target: undefined });
  });

  it('treats a whitespace-only param as unset', () => {
    expect(parseUrlState('?channel=%20%20')).toEqual({ channel: undefined, arch: undefined, start: undefined, target: undefined });
  });

  it('never throws on garbage/malformed input -- extra params, repeated params, encoded junk', () => {
    expect(() => parseUrlState('?channel=<script>&arch=💥&start=../../etc/passwd&bogus=1&channel=second')).not.toThrow();
    const result = parseUrlState('?channel=<script>&arch=💥&start=../../etc/passwd&bogus=1&channel=second');
    // URLSearchParams.get returns the FIRST value for a repeated key.
    expect(result.channel).toBe('<script>');
    expect(result.arch).toBe('💥');
    expect(result.start).toBe('../../etc/passwd');
  });
});

describe('serializeUrlState', () => {
  it('serializes a full selection', () => {
    const qs = serializeUrlState({ channel: 'stable-4.20', arch: 'amd64', start: '4.18.2', target: '4.20.32' });
    expect(new URLSearchParams(qs).get('channel')).toBe('stable-4.20');
    expect(new URLSearchParams(qs).get('arch')).toBe('amd64');
    expect(new URLSearchParams(qs).get('start')).toBe('4.18.2');
    expect(new URLSearchParams(qs).get('target')).toBe('4.20.32');
  });

  it('omits unset fields entirely rather than writing them as empty', () => {
    const qs = serializeUrlState({ channel: 'stable-4.20' });
    expect(qs).toBe('channel=stable-4.20');
  });

  it('produces an empty string for a fully-empty selection', () => {
    expect(serializeUrlState({})).toBe('');
  });
});

describe('parseUrlState / serializeUrlState round-trip', () => {
  it('round-trips a full valid selection', () => {
    const original = { channel: 'stable-4.20', arch: 'amd64' as const, start: '4.18.2', target: '4.20.32' };
    const roundTripped = parseUrlState(`?${serializeUrlState(original)}`);
    expect(roundTripped).toEqual(original);
  });

  it('round-trips values containing characters that need percent-encoding', () => {
    const original = { channel: 'weird channel/name?', start: 'a&b=c' };
    const roundTripped = parseUrlState(`?${serializeUrlState(original)}`);
    expect(roundTripped.channel).toBe('weird channel/name?');
    expect(roundTripped.start).toBe('a&b=c');
  });

  it('round-trips a partial selection (only channel set)', () => {
    const original = { channel: 'fast-4.19' };
    const roundTripped = parseUrlState(`?${serializeUrlState(original)}`);
    expect(roundTripped).toEqual({ channel: 'fast-4.19', arch: undefined, start: undefined, target: undefined });
  });
});

describe('resolveUrlArch', () => {
  it('uses the fallback with no notice when the param is absent', () => {
    expect(resolveUrlArch(undefined, 'amd64')).toEqual({ arch: 'amd64' });
  });

  it('accepts a recognised arch with no notice', () => {
    expect(resolveUrlArch('arm64', 'amd64')).toEqual({ arch: 'arm64' });
  });

  it('degrades an unrecognised arch to the fallback WITH a visible notice -- never a silent wrong selection', () => {
    const result = resolveUrlArch('bogus-arch', 'amd64');
    expect(result.arch).toBe('amd64');
    expect(result.notice).toBeDefined();
    expect(result.notice).toContain('bogus-arch');
  });

  it('never throws on garbage arch input', () => {
    expect(() => resolveUrlArch('<script>alert(1)</script>', 'amd64')).not.toThrow();
  });
});

describe('syncUrlState', () => {
  it('replaces the URL query string via history.replaceState, never pushState', () => {
    const replaceSpy = vi.fn();
    const pushSpy = vi.fn();
    const originalReplace = window.history.replaceState;
    const originalPush = window.history.pushState;
    window.history.replaceState = replaceSpy;
    window.history.pushState = pushSpy;
    try {
      syncUrlState({ channel: 'stable-4.20', arch: 'amd64' });
      expect(replaceSpy).toHaveBeenCalledTimes(1);
      expect(pushSpy).not.toHaveBeenCalled();
      const [, , url] = replaceSpy.mock.calls[0] as [unknown, unknown, string];
      expect(url).toContain('channel=stable-4.20');
      expect(url).toContain('arch=amd64');
    } finally {
      window.history.replaceState = originalReplace;
      window.history.pushState = originalPush;
    }
  });
});
