import type { Version } from '../graph/types';

/**
 * A `Version` decomposed into its semver components. Cincinnati versions are
 * semver with prereleases (`4.18.0-ec.0`, `4.18.0-rc.10`, ...) -- 38 distinct
 * prerelease versions are present across the pinned fixtures. No `semver`
 * dependency: the grammar this codebase actually needs (three numeric
 * components plus an optional dot-separated prerelease) is small enough that
 * pulling in a library would cost more in indirection than the ~40 lines below
 * cost in maintenance, and the branded `Version` type makes wrapping an
 * untyped external parser awkward at every call site.
 */
export interface ParsedVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  /** Dot-split prerelease identifiers, e.g. `['rc', '10']`. Empty for a release version. */
  readonly prerelease: readonly string[];
}

const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/;

/**
 * Parses a Cincinnati version string into its components. Throws on a string
 * that doesn't match `X.Y.Z[-prerelease]` -- every version that reaches this
 * function has already passed through `graph/parse.ts`'s validation boundary
 * (`z.string().min(1)`), so an unparseable version here means Cincinnati sent
 * something outside its documented format, which is a genuinely exceptional
 * condition worth a thrown error rather than a `Result` the whole engine would
 * have to thread through every comparison.
 */
export function parseVersion(v: Version): ParsedVersion {
  const match = VERSION_PATTERN.exec(v);
  if (!match) {
    throw new Error(`Not a valid semver-ish version string: ${JSON.stringify(v)}`);
  }
  const [, major, minor, patch, prerelease] = match;
  return {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    prerelease: prerelease ? prerelease.split('.') : [],
  };
}

/** True if every character of `s` is a digit (semver's definition of a "numeric identifier"). */
function isNumericIdentifier(s: string): boolean {
  return /^\d+$/.test(s);
}

/**
 * Compares two prerelease identifiers per semver §11.4.4: numeric identifiers
 * compare numerically (`rc.10` sorts after `rc.9` -- NOT lexically, where "10"
 * < "9"); a numeric identifier always sorts lower than an alphanumeric one;
 * two alphanumeric identifiers compare by ASCII/lexical order. This last rule
 * is what makes `ec` sort before `rc` -- 'e' < 'r' -- without any special
 * casing for engineering-candidate vs. release-candidate: it falls straight
 * out of ordinary string comparison of the identifiers semver already defines.
 */
function compareIdentifier(a: string, b: string): number {
  const aNumeric = isNumericIdentifier(a);
  const bNumeric = isNumericIdentifier(b);
  if (aNumeric && bNumeric) return Number(a) - Number(b);
  if (aNumeric) return -1;
  if (bNumeric) return 1;
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * Compares two prerelease identifier lists per semver §11.4: compared
 * identifier-by-identifier; a shorter list that is a prefix of the longer one
 * sorts lower (`rc.1` < `rc.1.2`); an empty list (no prerelease -- a release)
 * sorts *higher* than any non-empty prerelease list of the same
 * major.minor.patch (`4.18.0-rc.10` < `4.18.0`).
 */
function comparePrerelease(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1; // a is a release, b is a prerelease -- a is higher
  if (b.length === 0) return -1;

  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    if (i >= a.length) return -1; // a ran out of identifiers first -- a is lower
    if (i >= b.length) return 1;
    // biome-ignore lint: bounds already checked above
    const cmp = compareIdentifier(a[i] as string, b[i] as string);
    if (cmp !== 0) return cmp;
  }
  return 0;
}

/**
 * Total order over `Version`, per semver precedence rules: major, then minor,
 * then patch, numerically; then prerelease per {@link comparePrerelease}.
 * Negative if `a` sorts before `b`, positive if after, zero if equal.
 */
export function compareVersions(a: Version, b: Version): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (pa.major !== pb.major) return pa.major - pb.major;
  if (pa.minor !== pb.minor) return pa.minor - pb.minor;
  if (pa.patch !== pb.patch) return pa.patch - pb.patch;
  return comparePrerelease(pa.prerelease, pb.prerelease);
}
