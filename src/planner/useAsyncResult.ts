import { useCallback, useEffect, useRef, useState } from 'react';
import type { Result } from '../lib/result';

export type AsyncState<T, E> =
  | { readonly status: 'idle' }
  | { readonly status: 'loading' }
  | { readonly status: 'success'; readonly value: T }
  | { readonly status: 'error'; readonly error: E };

/** `AsyncState` plus the `retry` action -- a type alias (not an `interface extends`) so it stays a discriminated union: an `interface` can only extend an object type, and `AsyncState` is a union. */
export type AsyncResult<T, E> = AsyncState<T, E> & {
  /** Re-runs `task` against the current inputs (same `depsKey`) -- for an error retry. Does NOT bypass any cache the task itself consults. */
  readonly retry: () => void;
};

/**
 * Runs `task` whenever `active` is true, re-running it when `depsKey`
 * changes (or `retry()` is called). `depsKey` is a caller-computed string
 * identity for the task's real dependencies -- almost always a
 * `channel|arch[|start|target]`-shaped join -- rather than a raw dependency
 * array, because the task closures here read several loosely-related values
 * and an explicit string key is easier to audit for "did this actually
 * change" than trusting object identity across renders.
 *
 * Guards against stale responses two ways, per plan.md §6 ("a stale
 * response must never overwrite a newer selection"):
 *
 *  1. An `AbortController` is created per run and its `signal` handed to
 *     `task`, so a superseded run's in-flight network request is actually
 *     cancelled, not just ignored.
 *  2. A monotonically increasing generation counter gates whether a
 *     completed run's result is ever committed to state -- so even a task
 *     that resolves despite being superseded (a signal check the task
 *     itself forgot, or a genuine network race where the abort didn't land
 *     in time) can never clobber a newer selection's result. This is the
 *     actual correctness guarantee; the `AbortController` is an optimisation
 *     on top of it, not a substitute for it.
 */
export function useAsyncResult<T, E>(
  active: boolean,
  depsKey: string,
  task: (signal: AbortSignal) => Promise<Result<T, E>>,
): AsyncResult<T, E> {
  const [state, setState] = useState<AsyncState<T, E>>({ status: 'idle' });
  const generationRef = useRef(0);
  const taskRef = useRef(task);
  taskRef.current = task;
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!active) {
      setState({ status: 'idle' });
      return;
    }

    const myGeneration = generationRef.current + 1;
    generationRef.current = myGeneration;
    const controller = new AbortController();
    setState({ status: 'loading' });

    taskRef.current(controller.signal).then((result) => {
      if (myGeneration !== generationRef.current) return; // superseded by a newer run
      setState(result.ok ? { status: 'success', value: result.value } : { status: 'error', error: result.error });
    });

    return () => {
      controller.abort();
    };
    // `task` is intentionally excluded: callers pass a fresh closure every
    // render, and `depsKey` is the explicit, caller-computed signal for
    // "the task's actual inputs changed" -- see the doc comment above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, depsKey, nonce]);

  const retry = useCallback(() => setNonce((n) => n + 1), []);

  return { ...state, retry };
}
