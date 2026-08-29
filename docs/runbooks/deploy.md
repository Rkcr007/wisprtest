# Runbook — Deploy (kind-first)

How to run the control plane on a local kind cluster, and how a tester then uses
the console and the extension. Cloud Terraform is out of scope.

## What exists today

Track I shipped:

- Multi-stage Dockerfiles for gateway, indexer, composer, console
- A Helm umbrella at `infra/helm/wisprtest/` with one subchart per service
  (requests/limits, PDB, liveness `/healthz`, readiness `/readyz`, HPA on CPU)
- Grafana dashboard JSON for series that are actually emitted
  (`infra/grafana/`)
- `make kind-up` / `make kind-down`

What this is **not**:

- **Not a full cluster.** Postgres, Redis, Qdrant, MinIO and Dex stay on the
  Compose stack (`docker-compose.yml`). The Helm chart does not install them.
  Pods reach them at `host.docker.internal`. That is deliberate: a fake
  in-cluster postgres that nobody migrates is worse than an honest hybrid.
- **Not a cloud deploy.** No Terraform, no managed databases, no ingress
  controller, no cert-manager.
- **Not an observability stack.** There is still no collector, Prometheus or
  Grafana process. Dashboards import into one you already have. See
  `infra/grafana/README.md`.
- **Not the extension.** The hot path is an unpacked Chrome MV3 build. kind
  does not ship it.

## Prerequisites

| Tool | Why | This machine, when Track I landed |
|------|-----|-----------------------------------|
| Docker | Compose data plane + image builds | Required |
| `kind` | The cluster | **Must be installed.** https://kind.sigs.k8s.io/docs/user/quick-start/#installation |
| Helm 3 | Chart install | **Must be installed.** https://helm.sh/docs/intro/install/ |
| kubectl | Waits and debug | Docker Desktop ships one |
| `.env` | Every service boots from env, no defaults | Copy `.env.example` |

`make kind-up` fails by name if `kind` or `helm` is missing. It will not
silently skip the cluster.

Host port **3000** must be free. kind maps it to the console NodePort so Dex's
already-registered redirect (`http://localhost:3000/auth/callback` in
`infra/dex/config.yaml`) still matches. `make dev` bound to 3000 will collide —
stop it first.

## kind-up

From the repository root:

```bash
cp -n .env.example .env   # if you do not already have one
# fill EXTENSION_TOKEN_SIGNING_KEY and CONSOLE_SESSION_SECRET
make db-migrate           # once, against Compose postgres
make db-seed              # once, so Dex emails resolve to users
make kind-up
```

`kind-up` will:

1. Start Compose if it is not already up (`db-up`)
2. Create a kind cluster named `wisprtest` if one does not exist
3. Point `host.docker.internal` at the Compose host on Linux nodes
4. Build the four images and `kind load` them
5. Create Secret `wisprtest-runtime` from `.env`, rewriting only the
   connection strings pods use to reach Compose (`DATABASE_URL`, `REDIS_URL`,
   `QDRANT_URL`, `EVIDENCE_ENDPOINT`, `OIDC_JWKS_URI`). `OIDC_ISSUER_URL`
   stays `http://localhost:5556/dex` — that is what Dex signs. Pods get a
   `hostAliases` entry so `localhost` inside the pod is the Compose host.
6. `helm upgrade --install` the umbrella with `values-kind.yaml`
7. Wait until Deployments are available
8. Print `http://localhost:3000`

Expected wall time is dominated by the indexer image (Playwright's Chromium).
Subsequent runs reuse the cluster and rebuild only what Docker's cache misses.

```bash
# console
open http://localhost:3000

# fixture users — plaintext in .env.example on purpose
#   priya.lead@northwind.example      priya-local-dev-only
#   daniel.tester@northwind.example   daniel-local-dev-only
```

## kind-down

```bash
make kind-down
```

Deletes the kind cluster. Compose is left running (`make db-down` if you want
that gone too). Volumes stay.

## How a tester uses console + extension

The product is not a webpage. The tester narrates against a live application
in Chrome; the console is where they register that application, watch the
index, and review drift.

1. **Build the extension** (not in the cluster):
   ```bash
   pnpm --filter extension build
   ```
   Load `apps/extension/dist` as an unpacked extension at
   `chrome://extensions`.
2. **Sign in to the console** at `http://localhost:3000` as Priya or Daniel.
   The browser talks to Dex on `http://localhost:5556` (Compose). The console
   *server* talks to the in-cluster gateway.
3. **Connect** the application under test (URL + environment). That registers
   a row and can enqueue a crawl.
4. **Index** — the indexer worker inside kind opens Chromium and writes
   memory into Compose postgres. Progress streams through the gateway.
5. **Attach the extension** on a tab of that application. The extension asks
   the console (not the gateway) for a short-lived token, then runs
   speech → resolve → dispatch in-process. The hot path never crosses into
   kind.

If Chromium inside the indexer pod fails with `browser_failed`, read
`apps/indexer/src/crawl/browser.ts`: the worker launches with the sandbox on
and does not accept `--no-sandbox`. Kind nodes are privileged Docker
containers and usually allow that. A crawl that still cannot start is a
kernel/user-namespace problem, not a missing flag in this chart. The
`/healthz` and `/readyz` endpoints will still be green — they do not launch
a browser.

## Networking, honestly

```
tester browser  --:3000-->  kind NodePort  -->  console pod
tester browser  --:5556-->  Compose Dex
console pod     --DNS---->  gateway Service
gateway pod     --DNS---->  composer Service
gateway/indexer --host.docker.internal-->  Compose postgres/redis/qdrant/minio
console/gateway --localhost:5556-->  Compose Dex   (via hostAliases)
```

`OIDC_ISSUER_URL` cannot be rewritten to `host.docker.internal`. The console
refuses a discovery document whose `issuer` disagrees with the configured
value (`apps/console/src/auth/oidc.ts`), and Dex's issuer is
`http://localhost:5556/dex`. Mapping `localhost` inside the pod to the
Compose host is the kind-only workaround. It is not something to copy into
production.

## Health

| Process | Liveness | Readiness |
|---------|----------|-----------|
| gateway | `GET /healthz` | `GET /readyz` (postgres, redis, qdrant) |
| indexer | `GET /healthz` | `GET /readyz` (postgres, redis) |
| composer | `GET /healthz` | `GET /readyz` (no dependencies) |
| console | `GET /api/healthz` | `GET /api/readyz` (asks the gateway; no token) |

A console `/api/readyz` of 503 with `gateway.status: "unreachable"` almost
always means Compose is down or `host.docker.internal` does not resolve on
the kind node.

The gateway `/readyz` still checks Qdrant even though nothing in the
codebase reads or writes it. A Qdrant outage takes every gateway replica
out of rotation. See `docs/runbooks/README.md` § "Health and readiness".

## HPA

Each subchart has an HPA on CPU at 70%. kind does not ship
`metrics-server`. The objects exist; they will not scale until something
serves the metrics. API. That is not a stub — it is the same chart you
would take to a cluster that has metrics-server. Do not add a fake
metrics-server to kind to make the HPA "look live".

## Secrets

Nothing in `infra/helm/` or `infra/grafana/` is a credential. The runtime
Secret is created from `.env` at `kind-up` time and is never written to
disk in the repo. Rotate a value by editing `.env` and re-running
`make kind-up` (it `kubectl apply`s the Secret).

## What Track I did not do

- Terraform for managed Postgres / Redis / Qdrant / object storage
- A cluster-local data plane (Helm dependencies on Bitnami postgres, etc.)
- Installing Grafana, Prometheus, or an OTLP collector
- Alert rules for series that are not emitted
- Shipping the extension through the cluster
- `make ci`, `make load-test`, `make security-audit` — those are other
  Phase 19 tracks
