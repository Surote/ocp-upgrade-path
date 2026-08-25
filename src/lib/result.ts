/**
 * A minimal Result type so that expected failure paths (validation failure, an
 * empty-graph channel, a cache miss) are part of a function's return type rather
 * than something the caller only discovers by catching an exception. Reserve
 * thrown exceptions for truly unexpected conditions (a programmer error), not for
 * outcomes this codebase specifically anticipates.
 */
export type Result<T, E> = Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; error: E }>;

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}
