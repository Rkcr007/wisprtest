import { AuthProfile, CrawlBounds } from 'protocol';
import { z } from 'zod';

/**
 * What the Connect screen sends, and what the gateway sends back.
 *
 * The request half is composed from the contract's own `CrawlBounds` and `AuthProfile` — the same
 * two schemas `apps/gateway/src/routes/crawl.ts` composes its body from — so the console cannot
 * submit a shape the gateway will reject for a reason the console did not already know about.
 *
 * The response half is *not* in `packages/protocol`: the gateway declares the 202 body inline.
 * It is parsed here rather than trusted, so a change on that side surfaces as one named error
 * instead of an undefined job id in a redirect. Moving that shape into the contract is a change
 * for whoever owns the contract; this comment is the note asking for it.
 */

export const StartCrawlRequest = z.strictObject({
  bounds: CrawlBounds,
  authProfile: AuthProfile,
});
export type StartCrawlRequest = z.infer<typeof StartCrawlRequest>;

export const StartCrawlResponse = z.object({
  jobId: z.uuid(),
  applicationId: z.uuid(),
  messageId: z.string().min(1),
  requestedAt: z.iso.datetime(),
  progressUrl: z.string().min(1),
});
export type StartCrawlResponse = z.infer<typeof StartCrawlResponse>;
