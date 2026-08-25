import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { err, ok, type Result } from '../../lib/result';
import { useAsyncResult } from '../useAsyncResult';

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('useAsyncResult', () => {
  it('starts idle when inactive, and never calls the task', () => {
    const task = vi.fn();
    const { result } = renderHook(() => useAsyncResult(false, '', task));
    expect(result.current.status).toBe('idle');
    expect(task).not.toHaveBeenCalled();
  });

  it('transitions idle -> loading -> success', async () => {
    const task = vi.fn(async (): Promise<Result<string, never>> => ok('graph-a'));
    const { result } = renderHook(() => useAsyncResult(true, 'k1', task));

    expect(result.current.status).toBe('loading');
    await waitFor(() => expect(result.current.status).toBe('success'));
    expect(result.current).toMatchObject({ status: 'success', value: 'graph-a' });
  });

  it('surfaces a task error as status "error" with the error value intact', async () => {
    const task = vi.fn(async (): Promise<Result<never, string>> => err('boom'));
    const { result } = renderHook(() => useAsyncResult(true, 'k1', task));

    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current).toMatchObject({ status: 'error', error: 'boom' });
  });

  it('re-runs the task when depsKey changes', async () => {
    const task = vi.fn(async (): Promise<Result<string, never>> => ok('x'));
    const { rerender } = renderHook(({ key }) => useAsyncResult(true, key, task), { initialProps: { key: 'a' } });
    await waitFor(() => expect(task).toHaveBeenCalledTimes(1));

    rerender({ key: 'b' });
    await waitFor(() => expect(task).toHaveBeenCalledTimes(2));
  });

  it('does NOT re-run the task when depsKey is unchanged across a rerender', async () => {
    const task = vi.fn(async (): Promise<Result<string, never>> => ok('x'));
    const { rerender } = renderHook(({ key }) => useAsyncResult(true, key, task), { initialProps: { key: 'a' } });
    await waitFor(() => expect(task).toHaveBeenCalledTimes(1));

    rerender({ key: 'a' });
    // Give any accidental extra effect run a chance to fire before asserting it didn't.
    await new Promise((r) => setTimeout(r, 0));
    expect(task).toHaveBeenCalledTimes(1);
  });

  it('retry() re-invokes the task against the same depsKey', async () => {
    const task = vi.fn(async (): Promise<Result<string, never>> => ok('x'));
    const { result } = renderHook(() => useAsyncResult(true, 'k1', task));
    await waitFor(() => expect(task).toHaveBeenCalledTimes(1));

    act(() => result.current.retry());
    await waitFor(() => expect(task).toHaveBeenCalledTimes(2));
  });

  it('aborts the in-flight request when depsKey changes before it resolves', async () => {
    const first = deferred<Result<string, never>>();
    const signals: AbortSignal[] = [];
    const task = vi.fn((signal: AbortSignal) => {
      signals.push(signal);
      return first.promise;
    });

    const { rerender } = renderHook(({ key }) => useAsyncResult(true, key, task), { initialProps: { key: 'a' } });
    await waitFor(() => expect(task).toHaveBeenCalledTimes(1));
    expect(signals[0]?.aborted).toBe(false);

    rerender({ key: 'b' });
    expect(signals[0]?.aborted).toBe(true);
  });

  it('a stale response that resolves AFTER a newer selection was made never clobbers the newer result -- plan.md Q30', async () => {
    const slow = deferred<Result<string, never>>(); // the first (stale) request
    const fast = deferred<Result<string, never>>(); // the second (current) request

    let call = 0;
    const task = vi.fn(() => {
      call += 1;
      return call === 1 ? slow.promise : fast.promise;
    });

    const { result, rerender } = renderHook(({ key }) => useAsyncResult(true, key, task), { initialProps: { key: 'channel-a' } });
    await waitFor(() => expect(task).toHaveBeenCalledTimes(1));

    // User changes selection before the first request has resolved.
    rerender({ key: 'channel-b' });
    await waitFor(() => expect(task).toHaveBeenCalledTimes(2));

    // The NEWER request resolves first...
    await act(async () => {
      fast.resolve(ok('graph-b'));
    });
    await waitFor(() => expect(result.current).toMatchObject({ status: 'success', value: 'graph-b' }));

    // ...and then the STALE first request finally resolves too. It must be
    // discarded, not overwrite the already-committed newer result.
    await act(async () => {
      slow.resolve(ok('graph-a'));
    });
    // Give the stale .then() a turn to run before asserting it had no effect.
    await new Promise((r) => setTimeout(r, 0));
    expect(result.current).toMatchObject({ status: 'success', value: 'graph-b' });
  });
});
