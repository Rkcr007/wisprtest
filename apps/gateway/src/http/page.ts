import { z } from 'zod';

import { GatewayError } from '../errors.js';

const PageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

/**
 * `limit` / `offset` from a query string.
 *
 * Fastify hands query values as strings. Coercion is the contract: a missing pair is page one
 * of fifty, not a refusal, because every list the console opens should render without the
 * tester inventing pagination.
 */
export function parsePage(query: unknown): { readonly limit: number; readonly offset: number } {
  const parsed = PageQuery.safeParse(query);
  if (!parsed.success) {
    throw new GatewayError('validation_failed', 'invalid page', {
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join('.') || 'root',
        message: issue.message,
      })),
    });
  }
  return parsed.data;
}
