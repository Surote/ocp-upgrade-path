/**
 * Compile-time proof that NodeIndex and Version cannot be substituted for one
 * another, and that neither can be minted from a bare primitive outside
 * graph/parse.ts. This file is never executed -- `npx tsc --noEmit` failing is
 * the test. Each `@ts-expect-error` requires the next line to be a type error;
 * if the branding were ever weakened (e.g. the `__brand` field dropped), the
 * corresponding line would stop being an error and `@ts-expect-error` itself
 * would then fail to compile ("Unused '@ts-expect-error' directive").
 */
import type { NodeIndex, Version } from '../types';

declare function expectVersion(v: Version): void;
declare function expectNodeIndex(n: NodeIndex): void;

declare const nodeIndex: NodeIndex;
declare const version: Version;

// A NodeIndex must not be usable where a Version is expected...
// @ts-expect-error -- NodeIndex is not a Version
expectVersion(nodeIndex);

// ...nor a Version where a NodeIndex is expected...
// @ts-expect-error -- Version is not a NodeIndex
expectNodeIndex(version);

// ...and neither can be fabricated from a bare primitive, even though both
// are structurally primitives under the hood.
// @ts-expect-error -- a bare number is not a NodeIndex without going through graph/parse.ts
expectNodeIndex(3);
// @ts-expect-error -- a bare string is not a Version without going through graph/parse.ts
expectVersion('4.18.2');

export {};
