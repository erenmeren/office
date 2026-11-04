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
# node-pty (manual sessions) is a native module: the worker runs under Electron's Node (ELECTRON_RUN_AS_NODE), whose ABI differs
# from the system Node that pnpm built it with, so rebuild it against Electron's headers (node-addon-api is hoisted next to it)
ELECTRON_VERSION=$(node -p "require('./apps/desktop/node_modules/electron/package.json').version")
NODE_GYP=$(ls -d node_modules/.pnpm/node-gyp@*/node_modules/node-gyp/bin/node-gyp.js | head -1)
(cd "$OUT/server/node_modules/node-pty" && node "$OLDPWD/$NODE_GYP" rebuild --target="$ELECTRON_VERSION" --arch=x64 --dist-url=https://electronjs.org/headers)
ELECTRON_RUN_AS_NODE=1 apps/desktop/node_modules/.bin/electron -e "require('./$OUT/server/node_modules/node-pty')" && echo "node-pty loads under Electron $ELECTRON_VERSION"

cp -r apps/web/.next/standalone "$OUT/web"
mkdir -p "$OUT/web/apps/web/.next"
cp -r apps/web/.next/static "$OUT/web/apps/web/.next/static"
cp -r apps/web/public "$OUT/web/apps/web/public"
cp -r templates "$OUT/templates"
cp apps/desktop/assets/icon.png "$OUT/icon.png"
du -sh "$OUT/server" "$OUT/web"
