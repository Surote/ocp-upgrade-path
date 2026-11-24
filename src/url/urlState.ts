import type { RiskName } from '../engine/risks';
import type { RiskPolicy } from '../engine/routeConstraints';
import { isArch, type Arch } from '../graph/types';

const PARAM_CHANNEL = 'channel';
const PARAM_ARCH = 'arch';
const PARAM_START = 'start';
const PARAM_TARGET = 'target';
const PARAM_STOPS = 'stops';
const PARAM_AVOID = 'avoid';
const AVOID_CONDITIONAL = 'conditional';
const PARAM_NOT_APPLICABLE = 'na';

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
  /** `stops=v1,v2`, in order; blank entries dropped. */
  readonly stops?: readonly string[];
  readonly avoid?: string;
  /** `na=Name1,Name2`: risk names the operator marked not applicable; blank entries dropped. */
  readonly notApplicable?: readonly string[];
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
    stops: parseList(params.get(PARAM_STOPS)),
    avoid: cleanParam(params.get(PARAM_AVOID)),
    notApplicable: parseList(params.get(PARAM_NOT_APPLICABLE)),
  };
}

function parseList(v: string | null): readonly string[] | undefined {
  const items = (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return items.length > 0 ? items : undefined;
}

export interface UrlStateInput {
  readonly channel?: string;
  readonly arch?: Arch;
  readonly start?: string;
  readonly target?: string;
  readonly stops?: readonly string[];
  readonly riskPolicy?: RiskPolicy;
  readonly notApplicable?: readonly string[];
}

/** Serializes the current selection back into a canonical query string (no leading `?`), omitting any unset field. */
export function serializeUrlState(state: UrlStateInput): string {
  const params = new URLSearchParams();
  if (state.channel) params.set(PARAM_CHANNEL, state.channel);
  if (state.arch) params.set(PARAM_ARCH, state.arch);
  if (state.start) params.set(PARAM_START, state.start);
  if (state.target) params.set(PARAM_TARGET, state.target);
  const stops = state.stops?.filter(Boolean) ?? [];
  if (stops.length > 0) params.set(PARAM_STOPS, stops.join(','));
  if (state.riskPolicy === 'avoidConditional') params.set(PARAM_AVOID, AVOID_CONDITIONAL);
  if (state.notApplicable?.length) params.set(PARAM_NOT_APPLICABLE, [...state.notApplicable].sort().join(','));
  // A literal comma survives URLSearchParams parsing, and keeps `stops=` readable in a shared link.
  return params.toString().replace(/%2C/gi, ',');
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

export interface ResolvedUrlRiskPolicy {
  readonly riskPolicy: RiskPolicy;
  readonly notice?: string;
}

/** `avoid=conditional` selects `avoidConditional`; absent means `recommended`, and any other value degrades to it with a notice. */
export function resolveUrlRiskPolicy(raw: string | undefined): ResolvedUrlRiskPolicy {
  if (raw === undefined) return { riskPolicy: 'recommended' };
  if (raw === AVOID_CONDITIONAL) return { riskPolicy: 'avoidConditional' };
  return { riskPolicy: 'recommended', notice: `Unknown avoid value "${raw}" in link -- showing the recommended route.` };
}

export interface ResolvedUrlNotApplicable {
  readonly names: readonly RiskName[];
  readonly notice?: string;
}

/**
 * Keeps each linked name that exactly matches a conditional risk in `known`.
 * A name that matches none is dropped and named in the notice, never matched
 * loosely onto another risk.
 */
export function resolveUrlNotApplicable(raw: readonly string[], known: ReadonlySet<RiskName>): ResolvedUrlNotApplicable {
  const isKnown = (name: string): name is RiskName => (known as ReadonlySet<string>).has(name);
  const names = raw.filter(isKnown);
  const dropped = raw.filter((name) => !isKnown(name));
  if (dropped.length === 0) return { names, notice: undefined };
  const list = dropped.map((name) => `"${name}"`).join(', ');
  const noun = dropped.length === 1 ? 'that name, so the mark was' : 'those names, so the marks were';
  return { names, notice: `The link marked ${list} as not applicable, but no conditional risk on these channels has ${noun} dropped.` };
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
