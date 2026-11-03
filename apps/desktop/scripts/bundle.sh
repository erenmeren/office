#!/usr/bin/env bash
# Build the desktop app's resources into apps/desktop/build:
#   build/server  API, worker, db client, Postgres binaries and boot.mjs (pnpm deploy of @office/desktop-server)
#   build/web     the Next.js standalone server, built for the desktop ports
#   build/templates  the shipped skills, agents and subagents (seed and skill imports)
# Then `pnpm --filter @office/desktop start` runs it unpackaged, `pnpm --filter @office/desktop dist` makes the AppImage.
set -euo pipefail
cd "$(dirname "$0")/../../.."
OUT=apps/desktop/build

pnpm --filter @office/shared --filter @office/db --filter @office/runtime --filter @office/api --filter @office/worker build
(cd apps/web && rm -rf .next/standalone && NEXT_PUBLIC_API_URL=http://127.0.0.1:4100 OFFICE_DESKTOP_BUILD=1 pnpm build)

rm -rf "$OUT"
mkdir -p "$OUT"
pnpm deploy --legacy --prod --config.node-linker=hoisted --filter @office/desktop-server "$OUT/server"
# the bundled Postgres has no pgvector; a stub type lets the migration apply (apps/desktop/pgstub)
PG="$OUT/server/node_modules/@embedded-postgres/linux-x64/native"
cp apps/desktop/pgstub/* "$PG/share/postgresql/extension/"
# the package's postinstall creates lib symlinks; store real files so packaging cannot drop them
find "$PG/lib" -type l -exec sh -c 'cp --remove-destination "$(readlink -f "$1")" "$1"' _ {} \;
# dev-only trees that pnpm deploy copies along with the workspace packages
rm -rf "$OUT"/server/node_modules/@office/*/{src,test,data,tsconfig.json,vitest.config.ts}

cp -r apps/web/.next/standalone "$OUT/web"
mkdir -p "$OUT/web/apps/web/.next"
cp -r apps/web/.next/static "$OUT/web/apps/web/.next/static"
cp -r apps/web/public "$OUT/web/apps/web/public"
cp -r templates "$OUT/templates"
du -sh "$OUT/server" "$OUT/web"
