import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

/**
 * Unmount between tests.
 *
 * `@testing-library/react` registers this itself only when the runner exposes globals; this suite
 * imports `describe`/`it` explicitly, so it is wired up here. Without it every render accumulates
 * in the same document and the second test in a file finds two forms.
 */
afterEach(() => {
  cleanup();
});
