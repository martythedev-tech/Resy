#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "${TMP_DIR}"' EXIT

COMPOSE_PROJECT_NAME=resy \
RESY_IMAGE_TAG=v3.0.0 \
JWT_SECRET=deployment-preflight-test \
docker compose -f "${ROOT_DIR}/docker-compose.deploy.yml" config --quiet

RESOLVED_NAME="$(
  COMPOSE_PROJECT_NAME=resy \
  RESY_IMAGE_TAG=v3.0.0 \
  JWT_SECRET=deployment-preflight-test \
  docker compose -f "${ROOT_DIR}/docker-compose.deploy.yml" config |
    awk '$1 == "name:" { print $2; exit }'
)"
if [ "${RESOLVED_NAME}" != "resy" ]; then
  echo "FAIL: Compose resolved unexpected project name: ${RESOLVED_NAME:-unset}" >&2
  exit 1
fi

cat > "${TMP_DIR}/docker" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

if [ "${1:-}" = compose ]; then
  if [ "${2:-}" = version ]; then
    echo "Docker Compose mock"
    exit 0
  fi
  case " $* " in
    *" config --quiet "*) exit 0 ;;
    *" config --images "*)
      echo "ghcr.io/martythedev-tech/resy-api:v3.0.0"
      echo "ghcr.io/martythedev-tech/resy-web:v3.0.0"
      exit 0
      ;;
  esac
fi

if [ "${1:-}" = volume ] && [ "${2:-}" = inspect ]; then
  case ",${MOCK_VOLUMES:-}," in
    *",${3},"*) exit 0 ;;
    *) exit 1 ;;
  esac
fi

if [ "${1:-}" = volume ] && [ "${2:-}" = ls ]; then
  printf '%s' "${MOCK_VOLUMES:-}" | tr ',' '\n' | awk 'NF'
  exit 0
fi

if [ "${1:-}" = ps ]; then
  if [ "${MOCK_API_CONTAINER:-false}" = true ]; then
    echo "mock-api-container"
  fi
  exit 0
fi

if [ "${1:-}" = inspect ]; then
  if [[ "${3:-}" == *'/app/data'* ]]; then
    echo "${MOCK_ACTIVE_DATA:-}"
  elif [[ "${3:-}" == *'/app/uploads'* ]]; then
    echo "${MOCK_ACTIVE_UPLOADS:-}"
  fi
  exit 0
fi

echo "Unexpected mock docker call: $*" >&2
exit 1
EOF
chmod +x "${TMP_DIR}/docker"

write_env() {
  local tag="${1:-v3.0.0}"
  printf '%s\n' \
    'COMPOSE_PROJECT_NAME=resy' \
    "RESY_IMAGE_TAG=${tag}" \
    'JWT_SECRET=deployment-preflight-test' \
    > "${TMP_DIR}/deploy.env"
}

run_preflight() {
  PATH="${TMP_DIR}:${PATH}" "${ROOT_DIR}/scripts/preflight-deploy.sh" \
    --env-file "${TMP_DIR}/deploy.env" \
    --compose-file "${ROOT_DIR}/docker-compose.deploy.yml" \
    "$@"
}

expect_failure() {
  local label="$1"
  shift
  if "$@" > "${TMP_DIR}/failure.log" 2>&1; then
    echo "FAIL: ${label} unexpectedly passed" >&2
    exit 1
  fi
  echo "[OK] ${label} failed closed"
}

write_env
MOCK_VOLUMES='resy_resy_data,resy_resy_uploads' \
MOCK_API_CONTAINER=true \
MOCK_ACTIVE_DATA='resy_resy_data' \
MOCK_ACTIVE_UPLOADS='resy_resy_uploads' \
run_preflight >/dev/null
echo "[OK] Existing deployment passed"

write_env
MOCK_VOLUMES='' expect_failure "Update with no volumes" run_preflight
MOCK_VOLUMES='' run_preflight --allow-new-install >/dev/null
echo "[OK] Clean first installation passed only with explicit opt-in"

MOCK_VOLUMES='other_resy_data,other_resy_uploads' \
expect_failure "First install with another project volume pair" run_preflight --allow-new-install

MOCK_VOLUMES='resy_resy_data' \
expect_failure "Partial persistent-volume pair" run_preflight

MOCK_VOLUMES='resy_resy_data,resy_resy_uploads' \
MOCK_API_CONTAINER=true \
MOCK_ACTIVE_DATA='other_resy_data' \
MOCK_ACTIVE_UPLOADS='other_resy_uploads' \
expect_failure "Existing API container with mismatched mounts" run_preflight

write_env latest
MOCK_VOLUMES='resy_resy_data,resy_resy_uploads' \
expect_failure "Mutable image tag" run_preflight

echo "Deployment preflight smoke tests passed"
