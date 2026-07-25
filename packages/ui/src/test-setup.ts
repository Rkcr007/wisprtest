import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

/**
 * Unmount between tests.
 *
 * `@testing-library/react` registers this itself when a test runner exposes globals; this suite
 * imports `describe`/`it` explicitly, so it has to be wired up here. Without it every render
 * accumulates in the same document and the second test in a file finds two panels.
 */
afterEach(() => {
  cleanup();
});
