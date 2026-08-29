#!/usr/bin/env bash
# Delete the kind cluster created by kind-up. Compose is left running.
set -euo pipefail

CLUSTER="${KIND_CLUSTER:-wisprtest}"

if ! command -v kind >/dev/null 2>&1; then
  echo "kind-down: kind is not installed; nothing to delete." >&2
  exit 0
fi

if kind get clusters 2>/dev/null | grep -qx "${CLUSTER}"; then
  echo "kind-down: deleting cluster ${CLUSTER}"
  kind delete cluster --name "${CLUSTER}"
else
  echo "kind-down: cluster ${CLUSTER} does not exist"
fi
