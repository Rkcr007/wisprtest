import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * The ambient context of the request being served.
 *
 * `AsyncLocalStorage` rather than passing a context object down every call: the value has to
 * reach two places that are nowhere near the handler — the log serialiser, which stamps
 * `tenant_id` on every line without each call site remembering to, and the database layer,
 * which sets the row-level security variable from it. Threading a parameter through both would
 * mean a hundred call sites, any one of which could forget.
 *
 * ## Why the store is mutable, and why that is safe
 *
 * A request starts anonymous and becomes authenticated part-way through. The obvious approach —
 * establish a second context once the token is verified — does not work: `AsyncLocalStorage`
 * propagates into the async *subtree* of the call that created it, and a hook's subtree ends
 * when the hook returns. A context entered inside `preHandler` is gone by the time the handler
 * runs, which produces the worst possible failure: the request authenticates successfully, then
 * queries as nobody and quietly reads zero rows.
 *
 * So the store is one object, created at the start of the request and filled in by
 * {@link attachPrincipal}. Everything holding a reference sees the update, because it is the
 * same object.
 *
 * What keeps that safe is that the mutation is not general-purpose. `RequestContext` is
 * `readonly` to every consumer, `attachPrincipal` is the only writer, it is called from exactly
 * one place, and it refuses to overwrite a principal that is already set — so a request cannot
 * change tenant halfway through, which would make the audit trail a work of fiction.
 */
export interface RequestContext {
  /** Tenant of the authenticated principal. Every database read is scoped to it. */
  readonly tenantId: string;
  /** The authenticated user. Null on public routes such as `/healthz`. */
  readonly userId: string | null;
  /** RBAC role of the principal. Null when unauthenticated. */
  readonly role: string | null;
  /** Testing session, when the request carries one. Stamped on every log line. */
  readonly sessionId: string | null;
  /** OTel trace id, so a log line and a span can be lined up. */
  readonly traceId: string;
  /** Correlates every line emitted while serving one request. */
  readonly requestId: string;
}

/** The same shape, writable. Internal: only {@link attachPrincipal} holds one of these. */
type MutableRequestContext = { -readonly [K in keyof RequestContext]: RequestContext[K] };

const storage = new AsyncLocalStorage<MutableRequestContext>();

/** Run `work` with `context` ambient for its entire async subtree. */
export function runWithContext<T>(context: RequestContext, work: () => T): T {
  return storage.run({ ...context }, work);
}

export interface AuthenticatedPrincipal {
  readonly tenantId: string;
  readonly userId: string;
  readonly role: string;
  readonly sessionId: string | null;
}

/**
 * Record the authenticated principal on the current request's context.
 *
 * The only writer. Throws rather than silently doing nothing when there is no context, because
 * the alternative is a request that believes it authenticated and then reads as nobody.
 */
export function attachPrincipal(principal: AuthenticatedPrincipal): void {
  const store = storage.getStore();
  if (store === undefined) {
    throw new Error('attachPrincipal called outside a request context');
  }
  if (store.userId !== null) {
    // Two principals on one request means something has gone badly wrong upstream. Refusing is
    // the only safe answer: silently taking the second would make the audit trail a fiction.
    throw new Error('request already has an authenticated principal');
  }

  store.tenantId = principal.tenantId;
  store.userId = principal.userId;
  store.role = principal.role;
  store.sessionId = principal.sessionId;
}

/** The current context, or `undefined` outside a request — during boot, or in a background job. */
export function currentContext(): RequestContext | undefined {
  return storage.getStore();
}

/**
 * The current tenant, or `undefined`.
 *
 * Deliberately not a throwing accessor. The one caller that must have a tenant is the database
 * layer, and it raises `TenantContextMissingError` naming the operation it was asked to
 * perform — far more useful than a throw from inside a getter with no idea who called it.
 */
export function currentTenantId(): string | undefined {
  return storage.getStore()?.tenantId;
}
