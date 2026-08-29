import { z } from 'zod';

/**
 * What a console BFF answers with when it refuses.
 *
 * Shared by client screens so a drift decision and a crawl start parse the same error body —
 * `issues` from a gateway `validation_failed` survive so a form can attach them to a field.
 */
export const ConsoleRouteError = z.object({
  code: z.string(),
  message: z.string(),
  issues: z.array(z.object({ path: z.string(), message: z.string() })).default([]),
});
export type ConsoleRouteError = z.infer<typeof ConsoleRouteError>;
