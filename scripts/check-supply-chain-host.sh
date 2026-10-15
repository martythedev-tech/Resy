#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  bash scripts/check-supply-chain-host.sh [--sshpass] <user@host> [remote_root] [remote_scan_path]

Examples:
  bash scripts/check-supply-chain-host.sh user@example-host
  SSHPASS='<password>' bash scripts/check-supply-chain-host.sh --sshpass user@example-host

Notes:
  - This script is read-only.
  - It runs the local supply-chain scanner, then streams the same scanner over SSH to the remote host.
  - When --sshpass is used, SSH is invoked as `sshpass -e ssh -o StrictHostKeyChecking=no`.
  - Default remote_root is `~/Resy`; default remote_scan_path is `~`.
EOF
}

USE_SSHPASS=0
POSITIONAL=()

while (($# > 0)); do
  case "$1" in
    --sshpass)
      USE_SSHPASS=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      POSITIONAL+=("$1")
      shift
      ;;
  esac
done

set -- "${POSITIONAL[@]}"

REMOTE_TARGET="${1:-}"
REMOTE_ROOT="${2:-~/Resy}"
REMOTE_SCAN_PATH="${3:-~}"

if [[ -z "$REMOTE_TARGET" ]]; then
  usage
  exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

SSH_CMD=(ssh)
if [[ "$USE_SSHPASS" -eq 1 ]]; then
  if [[ -z "${SSHPASS:-}" ]]; then
    echo "SSHPASS must be set when --sshpass is used." >&2
    exit 2
  fi
  SSH_CMD=(sshpass -e ssh -o StrictHostKeyChecking=no)
fi

echo "== Local Resy =="
python3 "$SCRIPT_DIR/check-supply-chain.py" --root "$REPO_ROOT"

echo
echo "== Remote host summary =="
"${SSH_CMD[@]}" "$REMOTE_TARGET" \
  "hostname; echo '---'; docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}' || true; echo '---'; systemctl is-enabled resy-docker.service resy-api.service resy-web.service 2>/dev/null || true"

echo
echo "== Remote Resy + host scan =="
"${SSH_CMD[@]}" "$REMOTE_TARGET" \
  python3 - --root "$REMOTE_ROOT" --path "$REMOTE_SCAN_PATH" --scan-npm-home \
  < "$SCRIPT_DIR/check-supply-chain.py"
