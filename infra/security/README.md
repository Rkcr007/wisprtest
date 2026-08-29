# Security audit

`audit.mjs` is Phase 19's blocking security pass. It executes the controls rather than checking
that configuration files merely exist:

- npm advisory audit at `high` severity;
- OSV scan of the committed Python `uv.lock`;
- production nonce CSP assertions;
- Chrome extension permission allowlist and adjacent justifications;
- gateway and indexer log-sink redaction;
- PostgreSQL RLS catalogue and cross-tenant behavior;
- extension and gateway model-boundary redaction.

## Prerequisites

- Node 22 and the repository-pinned pnpm;
- Docker with Compose;
- the local stack migrated and seeded:

  ```sh
  make db-up db-migrate db-seed
  ```

Then run:

```sh
node infra/security/audit.mjs
```

The Python audit uses the official OSV Scanner `v2.5.1` container pinned by digest. It does not
depend on a mutable `latest` tag or a globally installed Python audit tool. Advisory checks need
registry and OSV network access; an unavailable registry is a failed audit, never a skipped one.

Every required check runs even when an earlier check fails, and the final summary exits nonzero if
any check did not execute successfully.
