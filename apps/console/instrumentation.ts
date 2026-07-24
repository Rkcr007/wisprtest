/**
 * Next calls `register()` once per server process, before any request is handled.
 *
 * Next bundles this file for the edge runtime as well as the Node.js one, and it resolves
 * imports statically — a runtime `NEXT_RUNTIME` guard is not enough to keep Node-only code out
 * of the edge bundle. The Node bootstrap therefore lives behind a dynamic import that only the
 * Node.js runtime ever evaluates.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') {
    return;
  }

  const { start } = await import('./src/instrumentation-node');
  start();
}
