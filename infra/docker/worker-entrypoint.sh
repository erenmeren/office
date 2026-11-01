#!/bin/sh
set -e
if [ ! -f "${OFFICE_WORKER_HOME:-/office-worker}/credentials.json" ] && [ -z "$OFFICE_ENROLL_TOKEN" ]; then
  echo "OFFICE_ENROLL_TOKEN required on first start" >&2
  exit 2
fi
exec "$@"
