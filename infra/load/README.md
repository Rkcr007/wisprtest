# Fifty-session load gate

`run.mjs` drives 50 concurrent, production-shaped extension sessions through a real gateway and
the Compose Postgres, Redis, Qdrant, MinIO, and Dex services.

Each session:

1. mints its own origin-scoped extension token from a real Dex access token;
2. loads the active memory snapshot;
3. opens a session;
4. requests and uploads redacted evidence directly to MinIO;
5. ingests five Class R, T0 steps with the evidence reference; and
6. closes the session.

The runner builds and owns a production gateway process. It refuses to use an already-listening
process because its configuration and code revision would be unknown. Every opened session is
closed, including best-effort cleanup after a failed operation; the workload does not seed or
mutate the application under test.

## Run

Prepare the idempotent local fixture:

```sh
make db-up db-migrate db-seed
node infra/load/run.mjs
```

The gate fails if any session operation returns a non-2xx status or if p95 for any operation is
800 ms or more. The 800 ms ceiling is the repository's documented maximum network-assisted
runtime tier; session control-plane operations must not be slower than that least-frequent tier.
The extension's stricter T0, T1, scope-recompute, speech-to-reticle, and dispatch budgets remain
the responsibility of `make bench` because those paths execute in the browser and do not cross
this gateway.

The final line is machine-readable JSON with counts, p50, p95, and maximum latency per operation.
Tokens and pre-signed evidence URLs are never printed.
