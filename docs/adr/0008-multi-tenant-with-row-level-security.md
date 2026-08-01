# 0008 — Multi-tenant from line one, enforced by Postgres RLS

**Status:** Accepted
**Decided:** 2026-07-25 (`d60052e feat(db): PostgreSQL schema, row-level security and the seed fixture`)

---

## Context

Two decisions are bundled here because they are only defensible together.

**Multi-tenancy from line one.** The alternative is the usual one: build single-tenant, get a
customer, add a `tenant_id` column later. That migration is not a column — it is every query,
every cache key, every background job, every test fixture, and every place a developer wrote
`SELECT * FROM elements` because there was only ever one tenant's worth. It is done under time
pressure, by people who did not write the original queries, and the thing it is easy to miss is
a query that returns *too much* — which is silent until it is a breach notification.

**Enforcement at the database rather than in application code.** Application-level scoping means
every query carries `WHERE tenant_id = $1`, and correctness depends on nobody ever forgetting.
Code review does not reliably catch a missing `WHERE` clause. Tests do not catch it either,
because a test with one tenant's data in the database passes whether the clause is there or not.
The failure is invisible until there are two tenants and someone reads the wrong rows.

WisprTest holds, per tenant: the structure of a customer's internal applications, the routes and
element inventory of those applications, learned entity schemas, and session recordings with
evidence. Cross-tenant leakage here is not an embarrassment, it is the end of the company.

---

## Decision

Every tenant-scoped table carries `tenant_id`. Every one has row-level security enabled and
forced, with a policy covering all commands.

`db/migrations/20260725120002_row_level_security.sql` applies `tenant_isolation` to fifteen
tables — `users`, `applications`, `memory_versions`, `screens`, `elements`, `nav_edges`,
`aliases`, `entity_schemas`, `field_specs`, `materializers`, `sessions`, `session_steps`,
`seed_ledger`, `drift_reports`, `audit_log` — plus `tenants` itself, which needs its own policy
keyed on `id` rather than `tenant_id`.

Four implementation choices carry the weight:

**Fail closed.** The policy predicate is `tenant_id = app_current_tenant_id()`, and that function
is

```sql
SELECT nullif(current_setting('wispr.tenant_id', true), '')::uuid;
```

It returns NULL when the setting is unset *or* empty. A NULL comparison is NULL, which is not
true, so the row is filtered. Forgetting to set the tenant yields an empty result, never the
whole table. The `nullif` is load-bearing: `''::uuid` raises, and an exception inside a policy is
a much worse failure mode than an empty set.

**`SET LOCAL`, per transaction.** The tenant is declared with `SET LOCAL wispr.tenant_id = '<uuid>'`,
which is scoped to the transaction, so a pooled connection cannot leak one request's tenant into
the next. The gateway sets it from an `AsyncLocalStorage` context on checkout
(`apps/gateway/src/context/request-context.ts`, `apps/gateway/src/db/pool.ts`) and nothing else
is permitted to.

**`FORCE ROW LEVEL SECURITY`, and a non-owner role.** A table's owner bypasses its own policies
unless forced. Worse, the Compose Postgres runs migrations as a superuser, so a test connecting
with `DATABASE_URL` would see every tenant's rows and prove nothing. `wispr_app` exists for that
reason — a `NOLOGIN` role with DML rights and no bypass, reached only by `SET ROLE` from an
already-authenticated connection. Both the RLS integration test and the gateway's pool `SET ROLE
wispr_app` before doing any work. That is the only configuration under which these policies
actually apply, and it is easy to get wrong in a way that looks like it is working.

**`USING` and `WITH CHECK`, both.** `USING` filters what is visible; `WITH CHECK` governs what a
row may become. `USING` alone would let a tenant insert a row belonging to somebody else, which
it could then not see — a write nobody can audit, which is worse than a read nobody can perform.

Namespacing extends past Postgres: Redis keys go through `tenantKey()`
(`apps/indexer/src/redis/client.ts`, `apps/gateway/src/redis/client.ts`) and Qdrant is
per-tenant collections.

---

## Consequences

### What this buys

- A forgotten `WHERE tenant_id = …` returns zero rows instead of somebody else's. The most
  dangerous bug class in a multi-tenant system fails safe.
- It holds for code nobody reviewed carefully: a repository helper, a debugging query in a
  migration, an agent-written route. The guarantee does not depend on the author.
- Composite foreign keys (`FOREIGN KEY (screen_id, tenant_id) REFERENCES screens (id, tenant_id)`)
  make a cross-tenant reference a constraint violation rather than a data-integrity surprise, so
  a bad `memory_version_id` from another tenant surfaces as a clean 422 rather than a 500.
- Multi-tenancy never has to be retrofitted, and there is no single-tenant mode to migrate off.

### What it costs

- **Every read carries an implicit predicate.** RLS adds `tenant_id = …` to every query plan.
  Tables whose other indexes do not already lead with `tenant_id` needed one added purely to keep
  the predicate an index scan — eleven extra indexes in the RLS migration alone. That is write
  amplification and storage paid on every table, forever.
- **A whole class of confusing local failures.** Query returns nothing → is the data missing, is
  the tenant unset, or is the connection not `SET ROLE wispr_app`? All three look identical. This
  is a permanent tax on debugging, and the RLS migration's header comment exists to shorten it.
- **Every connection path must set the tenant.** `TenantDatabase` exposes `withTenant()` and
  `unscoped()`; the second exists because readiness probes and migrations genuinely have no
  tenant. `unscoped` is a hole, it is small and named, and it will be reached for by somebody in
  a hurry. It should be audited whenever it gains a new call site.
- **Superusers and `BYPASSRLS` roles still bypass everything**, and that cannot be switched off.
  Production credential hygiene is therefore load-bearing in a way RLS does not make safe: the
  policy protects against application bugs, not against a misconfigured role.
- **Composite foreign keys everywhere.** Carrying `tenant_id` into the key of nearly every FK
  makes the schema wordier and the ORM types wider. Compare the tables in
  `db/migrations/20260725120000_core_schema.sql` against the sketch in
  `docs/ARCHITECTURE.md § 4` — the real schema is substantially heavier, and this is most of why.
- **Cross-tenant analytics is now hard on purpose.** Any legitimate aggregate over all tenants
  needs a deliberate path, which is a feature at the point of a breach and a nuisance at the point
  of a board deck.

### What would reverse it

Nothing at this scale. At a much larger scale the pressure runs the other way — toward
database-per-tenant or schema-per-tenant for noisy-neighbour isolation — and that is a change of
mechanism rather than of principle. The principle, that isolation is enforced below the
application, survives it.
