import { vi } from 'vitest';

interface FakeResponseInit {
  readonly ok?: boolean;
  readonly status?: number;
  readonly statusText?: string;
}

/** Builds a minimal object satisfying the parts of `Response` GraphClient uses. */
export function fakeJsonResponse(body: unknown, init: FakeResponseInit = {}): Response {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    statusText: init.statusText ?? 'OK',
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

/** A `Response` whose `.json()` rejects, simulating a malformed/garbage body. */
export function fakeBrokenJsonResponse(init: FakeResponseInit = {}): Response {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    statusText: init.statusText ?? 'OK',
    json: () => Promise.reject(new SyntaxError('Unexpected token in JSON')),
  } as unknown as Response;
}

/** A jest/vitest mock matching the `fetch` signature GraphClient depends on. */
export function fakeFetch(impl: (url: string, init?: RequestInit) => Promise<Response>) {
  return vi.fn(impl) as unknown as typeof fetch;
}
