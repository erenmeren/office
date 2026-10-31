# Development

## Layout

- `apps/api`: Fastify control plane. `src/routes` (REST), `src/ws` (worker and UI gateways), `src/services` (scheduler, runs, tasks, agents, skills, subagent runs, event store, event hub), `src/plugins` (Prisma, auth). Tests in `apps/api/test`.
- `apps/worker`: worker process. `src/config.ts` (environment), `src/connection.ts` (WebSocket, enrollment, heartbeat, reconnect), `src/executor.ts` (runs a `RunSpec` through the adapter), `src/skills.ts` (materializes pinned skills into the run root, removes and sweeps run roots), `src/credentials.ts`. Tests in `apps/worker/test`, including the fake-adapter end-to-end test.
- `apps/web`: Next.js UI. Pages under `src/app` (including the Skill Library at `skills/` and Agent Studio at `agents/[id]`), API client, queries and the replaying WebSocket hook under `src/lib`.
- `packages/shared`: Zod schemas and types shared by all apps.
- `packages/db`: Prisma schema and migrations (`prisma/`), client factory (`src/index.ts`), seed (`src/seed.ts`).
- `packages/runtime`: `RuntimeAdapter`, `ClaudeAdapter`, `FakeAdapter`, `redactSecrets`, and `scripts/smoke-claude.ts`, `scripts/smoke-skills.ts`.
- `templates`: shipped skills (`templates/skills/<name>/SKILL.md`, 12), agent templates (`templates/agents/*.json`, 5) and subagent templates (`templates/subagents/*.json`, 6), read by the seed.

All packages are ESM TypeScript. Scripts run with `tsx`; packages build with `tsc` (the web app with `next build`).

## First run

```bash
pnpm install
cp .env.example .env            # then set COOKIE_SECRET and OFFICE_WORKSPACE_ROOTS
pnpm infra:up
pnpm db:migrate
pnpm seed
```

Then either `scripts/dev-all.sh` (exports `.env`, starts infra, migrates, runs `pnpm dev`), or start the pieces by hand in separate shells after `set -a; . ./.env; set +a`:

```bash
pnpm --filter @office/api dev
pnpm --filter @office/web dev
OFFICE_ENROLL_TOKEN=<token from the Workers page> pnpm --filter @office/worker dev   # first start only
```

`apps/api` and `apps/worker` import `@office/shared` and `@office/db` through their built `dist`, so after changing the Prisma schema or `packages/shared`, rebuild them before starting or testing the apps:

```bash
pnpm --filter @office/shared build && pnpm --filter @office/db build
```

`pnpm dev` also starts the worker, which exits with "No saved credential and no enroll token" until it has been enrolled once.

## Environment

The API and the worker read the process environment only; they do not load `.env` themselves. Prisma's config, the seed and the vitest configs do load the root `.env`.

- API: `DATABASE_URL`, `API_PORT`, `COOKIE_SECRET` (at least 32 characters), `WEB_ORIGIN`, `OFFICE_DATA_DIR`, and optionally `API_HOST` (`127.0.0.1`), `OFFICE_LEASE_SECONDS` (60), `OFFICE_HEARTBEAT_SECONDS` (10), `OFFICE_SCHEDULER_INTERVAL_MS` (2000), `OFFICE_SKILL_IMPORT_ROOTS` (colon-separated directories that local and `file://` skill imports may read; default `<repo>/templates/skills`).
- Worker: `OFFICE_API_URL`, `OFFICE_WORKER_HOME` (`~/.office-worker`), `OFFICE_WORKSPACE_ROOTS` (colon-separated; every root must exist), `OFFICE_RUNTIME` (`claude` or `fake`), `OFFICE_WORKER_CAPACITY`, optionally `OFFICE_ENROLL_TOKEN` and `OFFICE_WORKER_NAME` (defaults to the host name). Give every worker its own `OFFICE_WORKER_HOME`: a starting worker deletes every run root under `<OFFICE_WORKER_HOME>/runs`, so two workers sharing one would sweep each other's run roots.
- Web: `NEXT_PUBLIC_API_URL`.
- Tests: `DATABASE_URL_TEST` (the `office_test` database, created by the Compose init script).

## Tests

```bash
pnpm --filter @office/db migrate:test   # apply migrations to office_test, once per schema change
pnpm test                               # every package
pnpm --filter @office/api test          # one package
```

Tests use the real Postgres test database and the fake adapter; no test calls Claude. API test files share the test database and truncate it, so they run serially. The worker's `pretest` builds the API, because the end-to-end test starts the real API in-process.

Real-Claude checks are opt-in and cost money. The runtime smoke tests are `pnpm --filter @office/runtime exec tsx scripts/smoke-claude.ts` and, for a pinned skill, `scripts/smoke-skills.ts`. Their results are recorded in `docs/progress.md`.

## Before committing

```bash
pnpm typecheck && pnpm test && pnpm build
```

Update `docs/progress.md` at the end of every phase and whenever a decision changes.
