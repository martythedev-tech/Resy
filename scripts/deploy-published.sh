#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ROOT_DIR}/.env.deploy"
COMPOSE_FILE="${ROOT_DIR}/docker-compose.deploy.yml"
FIRST_INSTALL=false

usage() {
  cat <<'EOF'
Usage: scripts/deploy-published.sh [options]

Runs the fail-closed deployment preflight, pulls the configured immutable images,
and recreates the published-image stack without deleting persistent volumes.

Options:
  --env-file PATH       Deployment environment file (default: .env.deploy)
  --compose-file PATH   Compose file (default: docker-compose.deploy.yml)
  --first-install       Permit creation of a new persistent-volume pair
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
    --first-install)
      FIRST_INSTALL=true
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

PREFLIGHT=("${ROOT_DIR}/scripts/preflight-deploy.sh" --env-file "${ENV_FILE}" --compose-file "${COMPOSE_FILE}")
if [ "${FIRST_INSTALL}" = true ]; then
  PREFLIGHT+=(--allow-new-install)
fi
"${PREFLIGHT[@]}"

COMPOSE=(docker compose --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}")
"${COMPOSE[@]}" pull
"${COMPOSE[@]}" up -d --no-build --remove-orphans
"${COMPOSE[@]}" ps

echo "Deployment command completed. Run the health and acceptance checks before approval."
