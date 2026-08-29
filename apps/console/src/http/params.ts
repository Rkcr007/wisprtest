import { z } from 'zod';

import { ConsoleError } from '../errors';

/**
 * A path parameter that must be a UUID before the gateway is touched.
 *
 * The crawl route already refuses `../../etc/passwd` this way. Repeating the check at every new
 * BFF keeps a malformed id from becoming an upstream 404 that looks like a missing resource.
 */
export function requireUuid(value: string, label: string): string {
  const parsed = z.uuid().safeParse(value);
  if (!parsed.success) {
    throw new ConsoleError('gateway_rejected', `the ${label} is not a UUID`, { status: 400 });
  }
  return parsed.data;
}
