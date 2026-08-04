import { CompositionRequest, CompositionResponse } from 'protocol';

import { GatewayError } from '../errors.js';

/**
 * The gateway's client for `apps/composer`.
 *
 * A transport, and deliberately nothing more. The composer is stateless (ARCHITECTURE § 5): it
 * holds no database handle and reads no memory version, so everything it reasons over is assembled
 * here and travels in the request. That property is what makes this file short — there is no
 * session to manage, no cache to invalidate, and no ordering to get right.
 *
 * ## Why the response is parsed rather than trusted
 *
 * The composer generates its pydantic models from this same JSON Schema, so in principle its
 * output cannot disagree with `CompositionResponse`. In practice the two are separately deployed
 * artifacts and one of them can be older. Parsing here means a version skew surfaces as a typed
 * `validation_failed` naming the field, at the boundary, rather than as a preview card rendering
 * `undefined` at a tester.
 *
 * ## The timeout is the product's, not the network's
 *
 * CLAUDE.md budgets the composition preview at 1.2 s p95. A composer that is thinking for longer
 * than the configured ceiling has already failed the thing the tester cares about, so the request
 * is aborted and reported rather than waited out.
 */

export interface ComposerClient {
  /**
   * Compose a plan for one utterance.
   *
   * @throws {GatewayError} `dependency_unavailable` when the composer cannot be reached or is
   *   slower than the budget; `validation_failed` when it answers with something off-contract.
   */
  compose(request: CompositionRequest): Promise<CompositionResponse>;
}

export interface ComposerClientOptions {
  readonly baseUrl: string;
  readonly timeoutMs: number;
  /** Injectable so the suite can drive the client without a composer process. */
  readonly fetch?: typeof globalThis.fetch;
}

export function createComposerClient(options: ComposerClientOptions): ComposerClient {
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  const endpoint = new URL('/compose', options.baseUrl).href;

  return {
    async compose(request: CompositionRequest): Promise<CompositionResponse> {
      const controller = new AbortController();
      const timer = setTimeout(() => {
        controller.abort();
      }, options.timeoutMs);

      let response: Response;
      try {
        response = await fetchImpl(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          // Validated on the way out as well as on the way back. The request is assembled from
          // learned schemas and a live runtime state, and a malformed one would come back as a
          // 422 from FastAPI that says nothing about which of those was wrong.
          body: JSON.stringify(CompositionRequest.parse(request)),
          signal: controller.signal,
        });
      } catch (error: unknown) {
        const timedOut = controller.signal.aborted;
        throw new GatewayError(
          'dependency_unavailable',
          timedOut
            ? `the composer did not answer within ${String(options.timeoutMs)}ms`
            : 'the composer could not be reached',
          { dependency: 'composer' },
          { cause: error },
        );
      } finally {
        clearTimeout(timer);
      }

      if (!response.ok) {
        // The composer's own body is not forwarded. It is a FastAPI validation dump or a Python
        // traceback, neither of which means anything to a tester, and either of which could
        // contain a fragment of the records the request carried.
        throw new GatewayError(
          'dependency_unavailable',
          `the composer answered ${String(response.status)}`,
          { dependency: 'composer', status: response.status },
        );
      }

      const parsed = CompositionResponse.safeParse(await response.json());
      if (!parsed.success) {
        throw new GatewayError('validation_failed', 'the composer answered off-contract', {
          issues: parsed.error.issues.map((issue) => ({
            path: issue.path.map(String).join('.') || 'root',
            message: issue.message,
          })),
        });
      }

      return parsed.data;
    },
  };
}
