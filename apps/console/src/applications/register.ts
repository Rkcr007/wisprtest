import type { Session } from '../auth/session';
import { ConsoleError } from '../errors';
import { callGatewayJson } from '../gateway/client';
import { originOf } from './origin';
import { ApplicationList, ApplicationRecord, type CreateApplicationRequest } from './schema';

/**
 * Register an application, or return the existing row when this tenant already has that name
 * at that origin.
 *
 * The gateway treats a duplicate name or origin as `validation_failed`. Asking the tester to
 * invent a unique name for an app they already registered is friction with no safety in it;
 * reusing the row they already own is the same decision. A name that exists at a *different*
 * origin, or an origin registered under a *different* name, is still a refusal — those are two
 * applications, and silently picking one would send the crawl at the wrong URL.
 */
export async function registerOrReuse(
  session: Session,
  body: CreateApplicationRequest,
): Promise<{ readonly created: boolean; readonly application: ApplicationRecord }> {
  try {
    const application = await callGatewayJson(
      session,
      { method: 'POST', path: '/v1/applications', body },
      ApplicationRecord,
    );
    return { created: true, application };
  } catch (error: unknown) {
    if (!(error instanceof ConsoleError) || error.wispr?.code !== 'validation_failed') {
      throw error;
    }

    const listed = await callGatewayJson(
      session,
      { method: 'GET', path: '/v1/applications' },
      ApplicationList,
    );
    const origin = originOf(body.baseUrl);
    const match = listed.applications.find(
      (row) =>
        row.name.toLowerCase() === body.name.toLowerCase() && originOf(row.baseUrl) === origin,
    );
    if (match === undefined) throw error;
    return { created: false, application: match };
  }
}
