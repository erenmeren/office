#!/usr/bin/env bash
# Start infra, apply migrations, then run every package in watch mode.
set -euo pipefail
cd "$(dirname "$0")/.."
# the API and worker read configuration from the process environment only
set -a
. ./.env
set +a
pnpm infra:up
pnpm db:migrate
pnpm dev
