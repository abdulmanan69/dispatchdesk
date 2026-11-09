#!/bin/sh
# Container entrypoint: apply database migrations to the persistent volume, then start the app.
set -e

mkdir -p "${DATA_DIR:-/data}/uploads"

if [ ! -w "${DATA_DIR:-/data}" ]; then
  echo "[entrypoint] ERROR: ${DATA_DIR:-/data} is not writable by $(id -u). Fix volume permissions." >&2
  exit 1
fi

echo "[entrypoint] applying database migrations"
npx --no-install prisma migrate deploy

echo "[entrypoint] starting: $*"
exec "$@"
