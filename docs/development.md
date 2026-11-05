# Development

## Layout

- `apps/api`: Fastify control plane. `src/routes` (REST), `src/ws` (worker and UI gateways), `src/services` (scheduler, runs, tasks, agents, skills, subagent runs, event store, event hub, and from Phase 3 messages, memory, the context pack, office tool execution and the summary prompt), `src/plugins` (Prisma, auth). Tests in `apps/api/test`.
- `apps/worker`: worker process. `src/config.ts` (environment), `src/connection.ts` (WebSocket, enrollment, heartbeat, reconnect), `src/executor.ts` (runs a `RunSpec` through the adapter, relays office tool calls as `tool.call` / `tool.result`), `src/skills.ts` (materializes pinned skills into the run root, removes and sweeps run roots), `src/credentials.ts`. Tests in `apps/worker/test`, including the fake-adapter end-to-end tests (`e2e-fake.test.ts`, `e2e-phase3.test.ts` for messaging, wake, suspend and resume, memory and summaries, `e2e-phase4.test.ts`, the Phase 4 mission test for plan, approval, worktrees, check, integration, required consultation and Chief review, and `e2e-phase5.test.ts`, the Phase 5 test with a local and a cloning worker). `src/git.ts` holds the worktree, mission branch, trailer hook, env template, fast-forward and remote push helpers; `src/repos.ts` clones and fetches projects from the API's git endpoint; `src/outbox.ts` keeps undelivered results on disk.
- `apps/web`: Next.js UI. Pages under `src/app` (Dashboard, Mission Control at `mission-control/`, Skill Library at `skills/`, Agent Studio at `agents/[id]`, Conversations at `conversations/`, Project Memory at `memory/`), API client, queries, status/identity/layout helpers and the replaying WebSocket hook under `src/lib`. Design tokens in `src/app/globals.css`; visual components in `src/components/ui` (shadcn pattern: `cva` variants, `cn`, `data-slot`, Tailwind classes inside the component, no inline styles in pages); screen-level components (`app-shell`, `plan-graph`, `task-detail`, `chief-composer`) in `src/components`.
- `packages/shared`: Zod schemas and types shared by all apps.
- `packages/db`: Prisma schema and migrations (`prisma/`), client factory (`src/index.ts`), seed (`src/seed.ts`).
- `packages/runtime`: `RuntimeAdapter`, `ToolBridge`, `ClaudeAdapter` (serves the office tools as the in-process MCP server `office`), `FakeAdapter` (markers `SEND:`, `ASK:`, `MEMO:`, `INBOX` drive the office tools in tests), `redactSecrets`, and `scripts/smoke-claude.ts`, `scripts/smoke-skills.ts`.
- `templates`: agent templates (`templates/agents/*.json`, 7, naming skills of the owner's Claude setup) and subagent templates (`templates/subagents/*.json`, 6), read by the seed.

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

- API: `DATABASE_URL`, `API_PORT`, `COOKIE_SECRET` (at least 32 characters), `WEB_ORIGIN`, `OFFICE_DATA_DIR`, and optionally `API_HOST` (`127.0.0.1`), `OFFICE_LEASE_SECONDS` (60), `OFFICE_HEARTBEAT_SECONDS` (10), `OFFICE_SCHEDULER_INTERVAL_MS` (2000), `OFFICE_SKILL_IMPORT_ROOTS` (colon-separated directories that local and `file://` skill imports may read; default `<repo>/templates/skills`). Phase 3: `OFFICE_MSG_PER_SESSION` (20), `OFFICE_MSG_PER_TASK` (100), `OFFICE_ESCALATION_DEPTH` (2), `OFFICE_HANDOFF_CHAIN` (3), `OFFICE_REPLY_TIMEOUT_MINUTES` (60; 0 resumes a waiting run on the next tick), `OFFICE_CONTEXT_PACK_MAX_CHARS` (12000). Phase 4 adds no environment variables: approval policies, `approvalTimeoutMinutes`, budgets and the check and setup commands are project settings (`PUT /projects/:id/settings`, the Settings page). Phase 5: the git endpoint needs the `git` binary on the API host and keeps its per-project link directories under `<OFFICE_DATA_DIR>/git-roots/`; `requiredWorkerTags` is a project setting. A worker on another machine or in a container needs `API_HOST=0.0.0.0` (or the address it connects to). Phase 6: `OFFICE_MACHINE_ID` (optional, 1–128 characters; replaces `/etc/machine-id` for hosts without one, set the same value on workers of this machine) and `OFFICE_GIT_TIMEOUT_SECONDS` (600; the git endpoint's per-request limit).
- Worker: `OFFICE_API_URL`, `OFFICE_WORKER_HOME` (`~/.office-worker`), `OFFICE_WORKSPACE_ROOTS` (colon-separated; every root must exist), `OFFICE_RUNTIME` (`claude` or `fake`), `OFFICE_WORKER_CAPACITY`, optionally `OFFICE_ENROLL_TOKEN` and `OFFICE_WORKER_NAME` (defaults to the host name). Phase 5: `OFFICE_WORKER_TAGS` (comma-separated, each `^[a-z0-9][a-z0-9-]{0,31}$`) and `OFFICE_WORKER_CAN_CLONE` (`true` lets the worker clone projects from the API; only then may `OFFICE_WORKSPACE_ROOTS` be empty). Phase 6: `OFFICE_MACHINE_ID` (optional; the same override as the API's, trimmed). A cloning worker keeps its clones under `<OFFICE_WORKER_HOME>/repos/<projectId>` and undelivered results under `<OFFICE_WORKER_HOME>/outbox/`. Give every worker its own `OFFICE_WORKER_HOME`: a starting worker deletes every run root under `<OFFICE_WORKER_HOME>/runs`, so two workers sharing one would sweep each other's run roots. Mission worktrees live under `<OFFICE_WORKER_HOME>/worktrees/<runId>`; a worktree whose commits were integrated is removed after the run, one with unintegrated commits or a suspended run is kept for inspection and swept after 7 days. A mission on an existing repository needs that repository under one of the worker's roots: extend `OFFICE_WORKSPACE_ROOTS` in your local `.env`, never in `.env.example`.
- Web: `NEXT_PUBLIC_API_URL`.
- Tests: `DATABASE_URL_TEST` (the `office_test` database, created by the Compose init script).

## Tests

```bash
pnpm --filter @office/db migrate:test   # apply migrations to office_test, once per schema change
pnpm test                               # every package
pnpm --filter @office/api test          # one package
```

Tests use the real Postgres test database and the fake adapter; no test calls Claude. API test files share the test database and truncate it, so they run serially. The worker's `pretest` builds the API, because the end-to-end test starts the real API in-process.

Real-Claude checks are opt-in and cost money. The Phase 3 messaging acceptance and the Phase 4 Maratus mission are driven through the running stack (see "Phase 3 acceptance" in `docs/progress.md`); it has no separate smoke script. The runtime smoke tests are `pnpm --filter @office/runtime exec tsx scripts/smoke-claude.ts` and, for a pinned skill and a subagent, `scripts/smoke-skills.ts` and `scripts/smoke-subagent.ts`. Their results are recorded in `docs/progress.md`.

### Two workers (Phase 5)

Run one local worker on the host and the remote worker container next to it:

```bash
set -a; . <(grep '^OFFICE_' .env); set +a; pnpm --filter @office/worker dev   # local worker
OFFICE_REMOTE_ENROLL_TOKEN=<token> pnpm worker:remote                           # first start; later without the token
```

The API must listen on `API_HOST=0.0.0.0` for the container to reach it (see README §15, including the firewall rule or the host-network override). The scheduler prefers the local worker; to see the container take a mission task, give the local worker `OFFICE_WORKER_CAPACITY=1` and plan two independent tasks with different agents, or set the project's `requiredWorkerTags` to `["remote"]` for a while (it also steers plan, review and summary runs). The container runs the fake runtime by default, so its tasks need the `COMMIT:<path>:<text>` marker in their description; keep the container's runtime the same as the host's when the Chief's plan and review runs should be real, because they can land on either worker.

`apps/worker/test/e2e-phase5.test.ts` covers the same ground without Docker: two fake-runtime workers against the in-process API, one local and one cloning over HTTP.

### Recovery (Phase 6)

`apps/worker/test/e2e-phase6-recovery.test.ts` (5 tests) restarts the in-process API under a fake-runtime worker: a run held mid-way survives the restart (lease reattached, one run, one `UsageRecord`, `seq`s contiguous from 1 including two events emitted while the API was down), a due summary and an expired approval resume from the database on the first tick, a question sent before the restart wakes its recipient after it, a result whose socket died before `run.result.ack` is re-sent and stored once, and a run whose lease was lost while it kept running does not fast-forward (`integration.check` answers `ok: false`). The worker buffers events produced while disconnected; a worker restart still loses them (see `docs/worker-protocol.md`).

The api and worker suites share the `office_test` database and truncate it, so never run them at the same time (for example `pnpm --filter @office/api test` in one shell and `pnpm --filter @office/worker test` in another). `pnpm test` (`pnpm -r test`) runs packages in dependency order, and the worker depends on the api, so the two suites never overlap there.

### Browser tests (Playwright)

`apps/web/e2e` drives the real app in Chromium: every page must render with no console error or warning, no request may leave localhost (fonts are self-hosted under `apps/web/src/app/fonts`), and Mission Control's task picking and composer gating are checked. The config starts the API (with the repo's `.env`) and the web app unless they already run. Owner credentials come from the environment, never from the repo:

```bash
pnpm --filter @office/web exec playwright install chromium   # once
OFFICE_E2E_EMAIL=... OFFICE_E2E_PASSWORD=... pnpm --filter @office/web e2e
```

With an empty database the suite creates the owner from those values.

The suite writes to the database it runs against: it sends owner messages and creates and verifies memory entries. Its memory test verifies the first entry that needs review, which may be an agent's real proposal. Run it against a database whose memory you do not mind changing. The suite also creates missions in `office-sandbox` that stay `planning` while no worker runs; a real worker connected later starts Chief plan runs for them. Cancel them (`POST /missions/:id/cancel`) before you connect a real worker.

### Migrations

`prisma migrate dev --create-only` emits drift SQL for the `MemoryEntry.search` column and the `MemoryEntry_search_idx` index, because Prisma cannot express a generated tsvector column. Before applying any generated migration, delete every statement that touches `MemoryEntry.search` or `MemoryEntry_search_idx` (the DROP INDEX and the ALTER COLUMN lines). After applying, confirm both still exist with `SELECT indexname FROM pg_indexes WHERE tablename = 'MemoryEntry'`. `prisma migrate dev` may hang after it has applied the migration; if it does not return within about a minute, stop it and confirm with `pnpm --filter @office/db exec prisma migrate deploy`. Then run `pnpm --filter @office/db migrate:test`.

## Before committing

```bash
pnpm typecheck && pnpm test && pnpm build
```

Update `docs/progress.md` at the end of every phase and whenever a decision changes.
