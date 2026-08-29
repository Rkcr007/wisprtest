import { HttpUrl } from 'protocol';
import { z } from 'zod';

/**
 * Application identity as the gateway returns it.
 *
 * Not in `packages/protocol`: Track 3 added the routes and declared the body inline. Parsed here
 * rather than trusted, so a drift surfaces as one named error instead of an undefined id in a
 * crawl URL. Moving the shape into the contract is a change for whoever owns the contract.
 */

export const ApplicationEnv = z.enum(['development', 'staging', 'production']);
export type ApplicationEnv = z.infer<typeof ApplicationEnv>;

export const CreateApplicationRequest = z.strictObject({
  name: z.string().trim().min(1).max(200),
  baseUrl: HttpUrl,
  env: ApplicationEnv,
});
export type CreateApplicationRequest = z.infer<typeof CreateApplicationRequest>;

export const ApplicationRecord = z.object({
  id: z.uuid(),
  tenantId: z.uuid(),
  name: z.string().min(1),
  baseUrl: HttpUrl,
  env: ApplicationEnv,
  createdAt: z.iso.datetime(),
});
export type ApplicationRecord = z.infer<typeof ApplicationRecord>;

export const ApplicationList = z.object({
  tenantId: z.uuid(),
  applications: z.array(ApplicationRecord),
});
export type ApplicationList = z.infer<typeof ApplicationList>;
