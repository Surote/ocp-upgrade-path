import { parseRiskId, type RiskId } from '../engine/risks';
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
  /** One `na=` per advisory the operator marked not applicable, verbatim (see `resolveUrlNotApplicable`); blank values dropped. */
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
    notApplicable: nonEmpty(params.getAll(PARAM_NOT_APPLICABLE).filter(Boolean)),
  };
}

function parseList(v: string | null): readonly string[] | undefined {
  return nonEmpty((v ?? '').split(',').map((s) => s.trim()).filter(Boolean));
}

function nonEmpty(items: readonly string[]): readonly string[] | undefined {
  return items.length > 0 ? items : undefined;
}

export interface UrlStateInput {
  readonly channel?: string;
  readonly arch?: Arch;
  readonly start?: string;
  readonly target?: string;
  readonly stops?: readonly string[];
  readonly riskPolicy?: RiskPolicy;
  readonly notApplicable?: readonly RiskId[];
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
  for (const mark of [...(state.notApplicable ?? [])].sort()) params.append(PARAM_NOT_APPLICABLE, mark);
  // These survive URLSearchParams parsing literally, and keep `stops=` and an advisory URL in `na=` readable in a shared link.
  return params.toString().replace(/%2C|%2F|%3A|%7E/gi, (escaped) => decodeURIComponent(escaped));
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
  readonly ids: readonly RiskId[];
  /** Set when a value has no `~` or nothing after it, so names no advisory URL; never matched by name alone. */
  readonly notice?: string;
}

/** Each `na=` value as the advisory it names, `name~url` (see `RiskId`). Whether a loaded graph carries it is the caller's to check. */
export function resolveUrlNotApplicable(raw: readonly string[] | undefined): ResolvedUrlNotApplicable {
  const ids: RiskId[] = [];
  const malformed: string[] = [];
  for (const value of raw ?? []) {
    const id = parseRiskId(value);
    if (id) ids.push(id);
    else malformed.push(value);
  }
  if (malformed.length === 0) return { ids };
  const list = malformed.map((value) => `"${value}"`).join(', ');
  return { ids, notice: `The link marked ${list} as not applicable without an advisory URL (name~url), so ${malformed.length === 1 ? 'it was' : 'they were'} dropped.` };
}

/** The notice for linked marks dropped because no loaded conditional risk is that advisory. */
export function droppedMarksNotice(dropped: readonly RiskId[]): string | undefined {
  if (dropped.length === 0) return undefined;
  const list = dropped.map((value) => `"${value}"`).join(', ');
  const tail =
    dropped.length === 1
      ? 'no conditional risk on these channels has that name and URL, so the mark was dropped.'
      : 'no conditional risk on these channels has those names and URLs, so the marks were dropped.';
  return `The link marked ${list} as not applicable, but ${tail}`;
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
