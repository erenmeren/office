# Remote Agent Office worker. Build from the repo root:
#   docker compose -f infra/compose.yaml --profile remote build worker-remote
FROM node:22-bookworm-slim AS build
# node-pty (manual sessions) compiles from source on Linux
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
RUN npm install -g pnpm@12
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile
# Only the worker and its runtime workspace deps; they need no Prisma client.
RUN pnpm --filter @office/shared --filter @office/runtime --filter @office/worker build
RUN pnpm deploy --legacy --filter @office/worker --prod /out

FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /out .
COPY infra/docker/worker-entrypoint.sh /usr/local/bin/worker-entrypoint.sh
ENV OFFICE_WORKER_HOME=/office-worker
RUN mkdir -p /office-worker && chown node:node /office-worker
USER node
ENTRYPOINT ["/usr/local/bin/worker-entrypoint.sh"]
CMD ["node", "dist/main.js"]
