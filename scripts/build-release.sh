#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

INPUT_VERSION="${1:-}"
PACKAGE_VERSION="$(node -p "require('./package.json').version")"
TAG_VERSION="$(git describe --tags --exact-match 2>/dev/null || true)"

if [ -n "${INPUT_VERSION}" ]; then
  RELEASE_VERSION="${INPUT_VERSION#v}"
elif [ -n "${TAG_VERSION}" ]; then
  RELEASE_VERSION="${TAG_VERSION#v}"
else
  RELEASE_VERSION="${PACKAGE_VERSION}"
fi

if ! [[ "${RELEASE_VERSION}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "ERROR: Release version must be semver (x.y.z). Got: ${RELEASE_VERSION}"
  exit 1
fi

BUILD_ID="$(git rev-parse --short HEAD 2>/dev/null || true)"
if [ -z "${BUILD_ID}" ]; then
  BUILD_ID="$(date +%Y%m%d%H%M%S)"
fi

echo "Building release..."
echo "Version: ${RELEASE_VERSION}"
echo "Channel: release"
echo "Build ID: ${BUILD_ID}"

VITE_APP_VERSION="${RELEASE_VERSION}" \
VITE_RELEASE_CHANNEL="release" \
VITE_BUILD_ID="${BUILD_ID}" \
npm run build

echo "Release build complete: v${RELEASE_VERSION} [release] (${BUILD_ID})"
