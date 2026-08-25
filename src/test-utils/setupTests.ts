// Extends Vitest's `expect` with jest-dom's DOM-specific matchers
// (`toBeInTheDocument`, `toBeDisabled`, etc.) for the light component tests
// in Phase 3 -- registered globally here via vite.config.ts's
// `test.setupFiles` rather than imported per test file.
import '@testing-library/jest-dom/vitest';
