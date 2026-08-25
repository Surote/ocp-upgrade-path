import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Deliberately NOT `new URL('../__fixtures__/', import.meta.url)`: Vite
// statically special-cases that exact literal pattern as an asset-URL
// reference (for bundling `<img src>`-style imports) and rewrites it to a
// dev-server URL like `http://localhost:3000/...` -- even under Vitest. Doing
// the path arithmetic ourselves via node:path avoids that rewrite and gets a
// real filesystem path.
const CURRENT_DIR = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(CURRENT_DIR, '..', '__fixtures__');

/**
 * Loads a pinned real graph fixture as an untyped JSON value -- the same shape
 * `response.json()` would hand back over the wire. Read as `unknown` on
 * purpose: tests should push it through the real validation boundary
 * (parseRawGraph), not assume it already matches the app's internal types.
 */
export function loadFixture(fileName: string): unknown {
  const raw = readFileSync(join(FIXTURES_DIR, fileName), 'utf-8');
  return JSON.parse(raw) as unknown;
}
