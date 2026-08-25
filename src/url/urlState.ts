import { isArch, type Arch } from '../graph/types';

const PARAM_CHANNEL = 'channel';
const PARAM_ARCH = 'arch';
const PARAM_START = 'start';
const PARAM_TARGET = 'target';

/**
 * The query string, parsed into raw (unvalidated) strings only. Deliberately
 * dumb: this module never mints a `Version` (only `graph/parse.ts`'s
 * `resolveVersion` may, once a graph has actually loaded) and only validates
 * what it can check without one -- the `arch` param, via `resolveUrlArch`
 * below. `start`/`target` stay opaque strings here; the caller resolves them
 * against a loaded `Graph` and is responsible for the "not found" notice.
 */
export interface RawUrlState {
  readonly channel?: string;
  readonly arch?: string;
  readonly start?: string;
  readonly target?: string;
}

function cleanParam(v: string | null): string | undefined {
  const trimmed = v?.trim();
  return trimmed ? trimmed : undefined;
}

/** Parses a query string (e.g. `location.search`, with or without the leading `?`) into raw param strings. Never throws -- `URLSearchParams` itself never does. */
export function parseUrlState(search: string): RawUrlState {
  const params = new URLSearchParams(search);
  return {
    channel: cleanParam(params.get(PARAM_CHANNEL)),
    arch: cleanParam(params.get(PARAM_ARCH)),
    start: cleanParam(params.get(PARAM_START)),
    target: cleanParam(params.get(PARAM_TARGET)),
  };
}

export interface UrlStateInput {
  readonly channel?: string;
  readonly arch?: Arch;
  readonly start?: string;
  readonly target?: string;
}

/** Serializes the current selection back into a canonical query string (no leading `?`), omitting any unset field. */
export function serializeUrlState(state: UrlStateInput): string {
  const params = new URLSearchParams();
  if (state.channel) params.set(PARAM_CHANNEL, state.channel);
  if (state.arch) params.set(PARAM_ARCH, state.arch);
  if (state.start) params.set(PARAM_START, state.start);
  if (state.target) params.set(PARAM_TARGET, state.target);
  return params.toString();
}

export interface ResolvedUrlArch {
  readonly arch: Arch;
  /** Set only when `raw` was present but not a recognised Arch -- a visible note for the UI, per plan.md Q21 ("degrade gracefully ... never a silent wrong selection"). */
  readonly notice?: string;
}

/**
 * Validates the raw `arch` query param against the known `Arch` enum
 * (graph/types.ts `ARCHES`). An absent param silently uses `fallback` (the
 * ordinary "no arch specified" case, not a garbage-input case). A *present
 * but unrecognised* value degrades to `fallback` too, but with a `notice` the
 * caller must surface -- never silently substituted without the user
 * knowing their link named something this app doesn't recognise.
 */
export function resolveUrlArch(raw: string | undefined, fallback: Arch): ResolvedUrlArch {
  if (raw === undefined) return { arch: fallback };
  if (isArch(raw)) return { arch: raw };
  return { arch: fallback, notice: `Unknown architecture "${raw}" in link -- defaulted to ${fallback}.` };
}

/**
 * Replaces the current URL's query string in place -- never pushes a new
 * history entry. Per plan.md §6 / Q21, every dropdown edit updates the
 * permalink, but doing that with `pushState` would spam the back button with
 * one entry per keystroke/selection; `replaceState` keeps the address bar in
 * sync without polluting history.
 */
export function syncUrlState(state: UrlStateInput): void {
  const qs = serializeUrlState(state);
  const url = `${window.location.pathname}${qs ? `?${qs}` : ''}${window.location.hash}`;
  window.history.replaceState(null, '', url);
}
