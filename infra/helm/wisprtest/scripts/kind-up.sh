#!/usr/bin/env bash
# Create (or reuse) a kind cluster, build and load the four control-plane images,
# helm-install them, and print the console URL.
#
# Data plane stays on Compose. This script will not invent postgres.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
CLUSTER="${KIND_CLUSTER:-wisprtest}"
NAMESPACE="${KIND_NAMESPACE:-wisprtest}"
RELEASE="${HELM_RELEASE:-wisprtest}"
CHART="${ROOT}/infra/helm/wisprtest"
SECRET_NAME="${KIND_SECRET_NAME:-wisprtest-runtime}"
IMAGE_TAG="${KIND_IMAGE_TAG:-kind}"

fail() {
  echo "kind-up: $*" >&2
  exit 1
}

need() {
  command -v "$1" >/dev/null 2>&1 || fail "$1 is not installed. $2"
}

need docker "Install Docker Desktop (or Engine) and start it."
need kind "Install kind: https://kind.sigs.k8s.io/docs/user/quick-start/#installation"
need helm "Install Helm 3: https://helm.sh/docs/intro/install/"
need kubectl "Install kubectl, or use the one bundled with Docker Desktop."

test -f "${ROOT}/.env" || fail "no .env — copy .env.example to .env and fill the secrets."

# Compose must already be healthy. kind-up is invoked after `make db-up` from the
# Makefile; this check is for anyone who runs the script directly.
if ! docker compose -f "${ROOT}/docker-compose.yml" --env-file "${ROOT}/.env" ps --status running --services 2>/dev/null | grep -qx postgres; then
  fail "Compose postgres is not running. Run \`make db-up\` first."
fi

if ! kind get clusters 2>/dev/null | grep -qx "${CLUSTER}"; then
  echo "kind-up: creating cluster ${CLUSTER}"
  kind create cluster --config "${CHART}/kind-cluster.yaml" --name "${CLUSTER}"
else
  echo "kind-up: reusing cluster ${CLUSTER}"
fi

# Linux kind nodes do not have host.docker.internal. Docker Desktop does.
# Add it so pods (and this script's IP lookup) have one name for the Compose host.
for node in $(kind get nodes --name "${CLUSTER}"); do
  if ! docker exec "${node}" getent hosts host.docker.internal >/dev/null 2>&1; then
    gw="$(docker exec "${node}" ip route show default | awk '{print $3; exit}')"
    test -n "${gw}" || fail "could not find a default gateway on ${node}"
    echo "kind-up: mapping host.docker.internal → ${gw} on ${node}"
    docker exec "${node}" bash -c "echo '${gw} host.docker.internal' >> /etc/hosts"
  fi
done

HOST_ALIAS_IP="$(docker exec "${CLUSTER}-control-plane" getent hosts host.docker.internal | awk '{print $1; exit}')"
test -n "${HOST_ALIAS_IP}" || fail "host.docker.internal does not resolve on the kind node"

echo "kind-up: building images (indexer pulls Playwright — this is the slow step)"
docker build -f "${ROOT}/apps/gateway/Dockerfile" -t "wisprtest/gateway:${IMAGE_TAG}" "${ROOT}"
docker build -f "${ROOT}/apps/indexer/Dockerfile" -t "wisprtest/indexer:${IMAGE_TAG}" "${ROOT}"
docker build -f "${ROOT}/apps/composer/Dockerfile" -t "wisprtest/composer:${IMAGE_TAG}" "${ROOT}"
docker build -f "${ROOT}/apps/console/Dockerfile" -t "wisprtest/console:${IMAGE_TAG}" "${ROOT}"

echo "kind-up: loading images into ${CLUSTER}"
kind load docker-image \
  "wisprtest/gateway:${IMAGE_TAG}" \
  "wisprtest/indexer:${IMAGE_TAG}" \
  "wisprtest/composer:${IMAGE_TAG}" \
  "wisprtest/console:${IMAGE_TAG}" \
  --name "${CLUSTER}"

kubectl get namespace "${NAMESPACE}" >/dev/null 2>&1 || kubectl create namespace "${NAMESPACE}"

# Rewrite only the connection strings pods use to reach Compose. OIDC_ISSUER_URL
# stays as localhost — Dex signs that issuer, and hostAliases makes it routable.
umask 077
RUNTIME_ENV="$(mktemp "${TMPDIR:-/tmp}/wisprtest-kind-env.XXXXXX")"
cleanup() {
  rm -f "${RUNTIME_ENV}"
}
trap cleanup EXIT

python3 - "${ROOT}/.env" "${RUNTIME_ENV}" <<'PY'
import re
import sys

src, dest = sys.argv[1], sys.argv[2]
rewrite = {
    "DATABASE_URL",
    "REDIS_URL",
    "QDRANT_URL",
    "EVIDENCE_ENDPOINT",
    "OIDC_JWKS_URI",
}
host_re = re.compile(r"(://[^@/]*@)?(localhost|127\.0\.0\.1)(?=[:/]|$)")

def remap(value: str) -> str:
    return host_re.sub(lambda m: f"{m.group(1) or ''}host.docker.internal", value)

lines: list[str] = []
seen_jwks = False
with open(src, encoding="utf-8") as fh:
    for raw in fh:
        line = raw.rstrip("\n")
        if not line or line.lstrip().startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        if key == "OIDC_JWKS_URI":
            seen_jwks = True
        if key in rewrite:
            value = remap(value)
        if key in {"GATEWAY_HOST", "INDEXER_HOST", "COMPOSER_HOST"}:
            value = "0.0.0.0"
        if key == "NODE_ENV":
            value = "production"
        lines.append(f"{key}={value}")

if not seen_jwks:
    lines.append("OIDC_JWKS_URI=http://host.docker.internal:5556/dex/keys")

with open(dest, "w", encoding="utf-8") as fh:
    fh.write("\n".join(lines) + "\n")
PY

kubectl -n "${NAMESPACE}" create secret generic "${SECRET_NAME}" \
  --from-env-file="${RUNTIME_ENV}" \
  --dry-run=client -o yaml | kubectl apply -f -

echo "kind-up: helm upgrade --install ${RELEASE}"
helm upgrade --install "${RELEASE}" "${CHART}" \
  --namespace "${NAMESPACE}" \
  --create-namespace \
  --values "${CHART}/values.yaml" \
  --values "${CHART}/values-kind.yaml" \
  --set "global.hostAliasIP=${HOST_ALIAS_IP}" \
  --set "global.envSecretName=${SECRET_NAME}" \
  --wait \
  --timeout 5m

echo ""
echo "kind-up: console is at http://localhost:3000"
echo "kind-up: sign-in uses Dex on http://localhost:5556 (Compose)."
echo "kind-up: load the unpacked extension from apps/extension — it is not in this cluster."
