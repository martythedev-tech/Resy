#!/bin/sh
set -eu

mkdir -p /app/data /app/uploads /app/certs
chown -R node:node /app/data /app/uploads

exec gosu node "$@"
