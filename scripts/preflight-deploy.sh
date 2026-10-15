#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ROOT_DIR}/.env.deploy"
COMPOSE_FILE="${ROOT_DIR}/docker-compose.deploy.yml"
ALLOW_NEW_INSTALL=false

usage() {
  cat <<'EOF'
Usage: scripts/preflight-deploy.sh [options]

Validates the published-image Docker deployment without changing containers or volumes.

Options:
  --env-file PATH       Deployment environment file (default: .env.deploy)
  --compose-file PATH   Compose file (default: docker-compose.deploy.yml)
  --allow-new-install   Permit both expected persistent volumes to be absent
  -h, --help            Show this help
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --env-file)
      ENV_FILE="${2:?--env-file requires a path}"
      shift 2
      ;;
    --compose-file)
      COMPOSE_FILE="${2:?--compose-file requires a path}"
      shift 2
      ;;
    --allow-new-install)
      ALLOW_NEW_INSTALL=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "ERROR: Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if ! command -v docker >/dev/null 2>&1; then
  echo "ERROR: Docker is not installed or is not in PATH." >&2
  exit 1
fi

if ! docker compose version >/dev/null 2>&1; then
  echo "ERROR: Docker Compose v2 is required." >&2
  exit 1
fi

if [ ! -r "${ENV_FILE}" ]; then
  echo "ERROR: Deployment environment is not readable: ${ENV_FILE}" >&2
  exit 1
fi

if [ ! -r "${COMPOSE_FILE}" ]; then
  echo "ERROR: Compose file is not readable: ${COMPOSE_FILE}" >&2
  exit 1
fi

read_env_value() {
  local key="$1"
  awk -v wanted="${key}" '
    /^[[:space:]]*#/ { next }
    {
      line = $0
      sub(/^[[:space:]]*/, "", line)
      split(line, parts, "=")
      candidate = parts[1]
      sub(/[[:space:]]*$/, "", candidate)
      if (candidate == wanted) {
        sub(/^[^=]*=/, "", line)
        sub(/^[[:space:]]*/, "", line)
        sub(/[[:space:]]*$/, "", line)
        if ((substr(line, 1, 1) == "\"" && substr(line, length(line), 1) == "\"") ||
            (substr(line, 1, 1) == "\047" && substr(line, length(line), 1) == "\047")) {
          line = substr(line, 2, length(line) - 2)
        }
        print line
        exit
      }
    }
  ' "${ENV_FILE}"
}

PROJECT_NAME="$(read_env_value COMPOSE_PROJECT_NAME)"
PROJECT_NAME="${PROJECT_NAME:-resy}"
IMAGE_TAG="$(read_env_value RESY_IMAGE_TAG)"

if ! [[ "${PROJECT_NAME}" =~ ^[a-z0-9][a-z0-9_-]*$ ]]; then
  echo "ERROR: COMPOSE_PROJECT_NAME must contain only lowercase letters, digits, underscores, or hyphens." >&2
  exit 1
fi

if ! [[ "${IMAGE_TAG}" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "ERROR: RESY_IMAGE_TAG must be an immutable release tag such as v3.0.0; got '${IMAGE_TAG:-unset}'." >&2
  exit 1
fi

COMPOSE=(docker compose --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}")
if ! "${COMPOSE[@]}" config --quiet; then
  echo "ERROR: Compose configuration validation failed." >&2
  exit 1
fi

EXPECTED_DATA_VOLUME="${PROJECT_NAME}_resy_data"
EXPECTED_UPLOADS_VOLUME="${PROJECT_NAME}_resy_uploads"
DATA_EXISTS=false
UPLOADS_EXISTS=false

if docker volume inspect "${EXPECTED_DATA_VOLUME}" >/dev/null 2>&1; then
  DATA_EXISTS=true
fi
if docker volume inspect "${EXPECTED_UPLOADS_VOLUME}" >/dev/null 2>&1; then
  UPLOADS_EXISTS=true
fi

if [ "${DATA_EXISTS}" != "${UPLOADS_EXISTS}" ]; then
  echo "ERROR: Only one expected persistent volume exists." >&2
  echo "Expected pair: ${EXPECTED_DATA_VOLUME}, ${EXPECTED_UPLOADS_VOLUME}" >&2
  echo "Do not deploy until the missing volume or the correct project name is resolved." >&2
  exit 1
fi

if [ "${DATA_EXISTS}" = false ]; then
  OTHER_VOLUMES="$(docker volume ls --format '{{.Name}}' | awk '/(^|_)resy_(data|uploads)$/')"
  if [ -n "${OTHER_VOLUMES}" ]; then
    echo "ERROR: The expected volumes do not exist, but other Resy volumes were found:" >&2
    printf '%s\n' "${OTHER_VOLUMES}" >&2
    echo "This usually means the Compose project name changed. Do not run 'up'." >&2
    echo "Set COMPOSE_PROJECT_NAME to the original project or follow the recovery guidance in docs/admin-docker-runbook.md." >&2
    exit 1
  fi

  if [ "${ALLOW_NEW_INSTALL}" != true ]; then
    echo "ERROR: Expected persistent volumes are absent:" >&2
    echo "  ${EXPECTED_DATA_VOLUME}" >&2
    echo "  ${EXPECTED_UPLOADS_VOLUME}" >&2
    echo "For a verified first-time installation only, rerun with --allow-new-install." >&2
    exit 1
  fi

  echo "[OK] Verified first-time installation: neither persistent volume exists yet."
else
  API_CONTAINERS="$(docker ps -aq \
    --filter "label=com.docker.compose.project=${PROJECT_NAME}" \
    --filter "label=com.docker.compose.service=api")"
  if [ -n "${API_CONTAINERS}" ]; then
    API_CONTAINER_COUNT="$(printf '%s\n' "${API_CONTAINERS}" | awk 'NF { count++ } END { print count + 0 }')"
    if [ "${API_CONTAINER_COUNT}" -ne 1 ]; then
      echo "ERROR: Expected at most one existing API container for project ${PROJECT_NAME}; found ${API_CONTAINER_COUNT}." >&2
      exit 1
    fi

    ACTIVE_DATA_VOLUME="$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/app/data"}}{{.Name}}{{end}}{{end}}' "${API_CONTAINERS}")"
    ACTIVE_UPLOADS_VOLUME="$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/app/uploads"}}{{.Name}}{{end}}{{end}}' "${API_CONTAINERS}")"
    if [ "${ACTIVE_DATA_VOLUME}" != "${EXPECTED_DATA_VOLUME}" ] || [ "${ACTIVE_UPLOADS_VOLUME}" != "${EXPECTED_UPLOADS_VOLUME}" ]; then
      echo "ERROR: The existing API container is not attached to the expected persistent volumes." >&2
      echo "Expected: ${EXPECTED_DATA_VOLUME}, ${EXPECTED_UPLOADS_VOLUME}" >&2
      echo "Actual: ${ACTIVE_DATA_VOLUME:-none}, ${ACTIVE_UPLOADS_VOLUME:-none}" >&2
      exit 1
    fi
  fi

  echo "[OK] Existing persistent volume pair found and matched to project ${PROJECT_NAME}."
fi

echo "[OK] Compose project: ${PROJECT_NAME}"
echo "[OK] Release tag: ${IMAGE_TAG}"
echo "[OK] Data volume: ${EXPECTED_DATA_VOLUME}"
echo "[OK] Uploads volume: ${EXPECTED_UPLOADS_VOLUME}"
echo "[OK] Resolved images:"
"${COMPOSE[@]}" config --images | sed 's/^/  /'
echo "Preflight passed. No containers or volumes were changed."
