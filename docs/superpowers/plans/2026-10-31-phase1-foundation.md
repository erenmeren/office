# Phase 1 — Working Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A user submits a task in the web UI, a local worker executes it through the Claude Agent SDK, and the normalized execution events and the result appear live in the UI and survive a restart.

**Architecture:** pnpm monorepo. `apps/api` (Fastify) is the control plane: auth, projects, agents with immutable versions, tasks, runs, leases, scheduler, worker WebSocket, UI WebSocket with replay. `apps/worker` connects outbound, leases runs, executes them through a `RuntimeAdapter` (`ClaudeAdapter` real, `FakeAdapter` for tests), and streams sequence-numbered events. `apps/web` (Next.js) shows tasks, workers and a live event log. Shared Zod schemas and the task state machine live in `packages/shared`; Prisma in `packages/db`; adapters in `packages/runtime`.

**Tech Stack:** Node 26, pnpm 12, TypeScript 5.9 (strict, ESM `NodeNext`), Fastify 5 + `@fastify/websocket` 11 + `@fastify/cookie` + `@fastify/cors`, Prisma 7 (`prisma-client` generator, `@prisma/adapter-pg`), Zod 4, `ws` 8, `@anthropic-ai/claude-agent-sdk` 0.3.x, Next.js 16 + React 19 + Tailwind 4 + shadcn/ui + TanStack Query 5, vitest 5, tsx, pino, argon2, Docker Compose (`pgvector/pgvector:pg16`, `redis:7-alpine`).

**Spec:** `docs/superpowers/specs/2026-10-31-agent-office-design.md` (§4 constraints, §5 shape, §8.2 state machine, §10 adapter and events, §11 workers, §12 web, §17 Phase 1 acceptance).

## Global Constraints

- Node `>=26`, pnpm `>=12`; every package `"type": "module"`, TypeScript `strict: true`, `module: NodeNext`, `target: ES2022`.
- Postgres published on host port `5433`, Redis on `6380`. Image `pgvector/pgvector:pg16`. Databases `office` and `office_test`.
- Prisma 7: generator `provider = "prisma-client"`, `output = "../src/generated/prisma"`; config in `packages/db/prisma.config.ts` with `import "dotenv/config"`; client built with `new PrismaClient({ adapter: new PrismaPg({ connectionString }) })`. Pin `prisma@7`, `@prisma/client@7`, `@prisma/adapter-pg@7` (the `latest` tag is an 8.x release candidate; do not use it).
- Agent SDK: `permissionMode: 'default'` always. Never `bypassPermissions`. Child env is `process.env` minus every key starting with `CLAUDE` and minus `AI_AGENT`, then `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS` and `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` set from the run spec. No `ANTHROPIC_API_KEY` is written anywhere; the worker inherits whatever auth its environment has.
- Every event carries the envelope `{ type, seq, ts, sessionId, runId, agentId, projectId, payload }`. `seq` is per session, monotonic from 1, assigned by the worker. `(sessionId, seq)` is unique in the database.
- Secret redaction runs in the worker before emission and in the API before persistence.
- No secrets to the browser. Cookie-based single-owner auth. Worker auth by credential, never by user session.
- Every task ends with its tests passing and a commit. Commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Code and docs in English.

## Review Focus

1. A worker reports `run.result` or `run.event` for a run whose lease it no longer holds (expired, or reassigned after reconnect): the API must reject it and must not change task state. Test in Task 6.
2. A worker reconnects and re-sends events already persisted (same `sessionId`, same `seq`): persistence must be idempotent, one row, no error surfaced to the worker. Test in Task 6.
3. UI reconnects with `afterSeq`: replay from the database must hand over to live delivery with no gap and no duplicate `seq`. Test in Task 7.
4. Worker disconnects mid-run: after lease expiry the run becomes `lost`, the task returns to `ready` once (`maxAttempts` default 2), and after the second loss becomes `failed`. Test in Task 6.
5. A tool result containing an API key pattern: the persisted `SessionEvent.payload` must contain `[REDACTED]` and not the key, both when the worker redacts and when a (test) worker sends it unredacted. Tests in Task 4 (worker side) and Task 6 (API side).

---

### Task 1: Monorepo scaffold, Compose, shared toolchain

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `.gitignore`, `.npmrc`, `.env.example`
- Create: `infra/compose.yaml`, `infra/docker/initdb/01-test-db.sql`
- Create: `packages/shared/package.json`, `packages/shared/tsconfig.json`, `packages/shared/src/index.ts`, `packages/shared/vitest.config.ts`
- Create: `CLAUDE.md`, `docs/progress.md`

**Interfaces:**
- Produces: workspace packages `@office/shared`, `@office/db`, `@office/runtime` (names fixed here; later tasks import them). Root scripts `pnpm dev`, `pnpm build`, `pnpm test`, `pnpm infra:up`, `pnpm infra:down`, `pnpm db:migrate`, `pnpm db:generate`.

- [ ] **Step 1: Root files**

`package.json`: `"private": true`, `"packageManager": "pnpm@12"`, scripts: `build: pnpm -r build`, `test: pnpm -r test`, `typecheck: pnpm -r typecheck`, `infra:up: docker compose -f infra/compose.yaml up -d --wait`, `infra:down: docker compose -f infra/compose.yaml down`, `db:generate: pnpm --filter @office/db generate`, `db:migrate: pnpm --filter @office/db migrate:dev`, `dev: pnpm -r --parallel dev`. Dev deps: `typescript@~5.9`, `vitest@^5`, `tsx@^4`, `@types/node@^26`.

`pnpm-workspace.yaml`: `packages: ["apps/*", "packages/*"]`.

`tsconfig.base.json`: `strict`, `module: NodeNext`, `moduleResolution: NodeNext`, `target: ES2022`, `esModuleInterop`, `skipLibCheck`, `declaration`, `sourceMap`, `verbatimModuleSyntax: true`.

`.gitignore`: `node_modules`, `dist`, `.env`, `.env.*`, `!.env.example`, `src/generated`, `.next`, `data/`.

`.env.example` (documented, no secrets):
```
DATABASE_URL=postgresql://office:office@localhost:5433/office
DATABASE_URL_TEST=postgresql://office:office@localhost:5433/office_test
REDIS_URL=redis://localhost:6380
API_PORT=4000
COOKIE_SECRET=change-me-32-chars-minimum-xxxxxxxxxx
WEB_ORIGIN=http://localhost:3000
OFFICE_DATA_DIR=./data
NEXT_PUBLIC_API_URL=http://localhost:4000
OFFICE_API_URL=ws://localhost:4000
OFFICE_WORKER_HOME=~/.office-worker
OFFICE_WORKSPACE_ROOTS=/home/meren/projects/office-workspaces
OFFICE_RUNTIME=claude
OFFICE_WORKER_CAPACITY=2
```

- [ ] **Step 2: Compose**

`infra/compose.yaml`: service `postgres` image `pgvector/pgvector:pg16`, env `POSTGRES_USER=office`, `POSTGRES_PASSWORD=office`, `POSTGRES_DB=office`, port `5433:5432`, volume `office-pg`, mount `./docker/initdb:/docker-entrypoint-initdb.d:ro`, healthcheck `pg_isready -U office`. Service `redis` image `redis:7-alpine`, port `6380:6379`, healthcheck `redis-cli ping`.

`infra/docker/initdb/01-test-db.sql`: `CREATE DATABASE office_test;` then `\c office` / `\c office_test` each with `CREATE EXTENSION IF NOT EXISTS vector;`.

- [ ] **Step 3: `packages/shared` skeleton**

`package.json` name `@office/shared`, `exports: { ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" } }`, scripts `build: tsc -p tsconfig.json`, `typecheck: tsc --noEmit -p tsconfig.json`, `test: vitest run`, `dev: tsc -w -p tsconfig.json`. Dependency `zod@^4`. `src/index.ts` exports nothing yet except `export const SHARED_VERSION = '0.1.0'`.

- [ ] **Step 4: `CLAUDE.md` and `docs/progress.md`**

`CLAUDE.md`: project one-liner, the spec and plan paths, the standing decisions from spec §19 and §20 as a bullet list, commands (`pnpm infra:up`, `pnpm db:migrate`, `pnpm dev`, `pnpm test`), rule "update `docs/progress.md` at the end of every phase and whenever a decision changes". `docs/progress.md`: Phase table (1–6) with status `not started`, Phase 1 `in progress`, and an empty "Outstanding" list.

- [ ] **Step 5: Verify**

Run: `pnpm install && pnpm infra:up && docker compose -f infra/compose.yaml ps && pnpm -r build`
Expected: both services `healthy`; build exits 0.
Run: `docker exec -i $(docker compose -f infra/compose.yaml ps -q postgres) psql -U office -d office_test -c '\dx'`
Expected: a row for `vector`.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "chore: monorepo scaffold, compose, shared package skeleton"
```

---

### Task 2: Shared enums, task state machine, event and protocol schemas

**Files:**
- Create: `packages/shared/src/enums.ts`, `packages/shared/src/task-state.ts`, `packages/shared/src/events.ts`, `packages/shared/src/protocol.ts`, `packages/shared/src/run-spec.ts`
- Modify: `packages/shared/src/index.ts` (re-export all)
- Test: `packages/shared/src/task-state.test.ts`, `packages/shared/src/events.test.ts`

**Interfaces:**
- Produces (`enums.ts`): `TaskStatus = z.enum(['planned','ready','queued','running','waiting_reply','waiting_approval','review','done','failed','cancelled','blocked'])`; `RunStatus = z.enum(['queued','running','waiting_reply','waiting_approval','succeeded','failed','cancelled','lost'])`; `RunKind = z.enum(['task','inbox','plan','review','summary','chat'])`; `WorkerStatus = z.enum(['pending','online','offline','revoked'])`; `EventType = z.enum([...])` with exactly the names in spec §10 plus `agent.text`, `run.lease.lost`, `run.status.changed`. Each with `type X = z.infer<...>`.
- Produces (`task-state.ts`): `transitionTask(from: TaskStatus, to: TaskStatus): TaskStatus` throwing `InvalidTransitionError(from, to)`; `canTransitionTask(from, to): boolean`; `TASK_TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]>`.
- Produces (`events.ts`): `OfficeEventSchema = z.object({ type: EventType, seq: z.number().int().positive(), ts: z.iso.datetime(), sessionId: z.string(), runId: z.string(), agentId: z.string(), projectId: z.string(), payload: z.record(z.string(), z.unknown()) })`; `type OfficeEvent`; `type EventBody = Pick<OfficeEvent, 'type' | 'payload'>`.
- Produces (`run-spec.ts`): `RunSpecSchema = z.object({ runId, sessionId, agentId, projectId, cwd, prompt, systemPrompt, model, effort: z.enum(['low','medium','high','xhigh','max']).optional(), allowedTools: z.array(z.string()), maxTurns: z.number().int(), maxBudgetUsd: z.number(), maxConcurrentSubagents: z.number().int().default(4), maxSubagentDepth: z.number().int().default(1), resumeSdkSessionId: z.string().optional() })`; `RunResultSchema = z.object({ status: z.enum(['succeeded','failed','cancelled']), resultText: z.string().optional(), error: z.string().optional(), sdkSessionId: z.string().optional(), usage: z.object({ inputTokens: z.number(), outputTokens: z.number(), costUsd: z.number(), numTurns: z.number(), durationMs: z.number() }) })`.
- Produces (`protocol.ts`): `WorkerToApiSchema = z.discriminatedUnion('type', [ hello {type:'hello', enrollToken?: string, credential?: string, name: string, capacity: number, allowedRoots: string[], activeRunIds: string[]}, heartbeat {type:'heartbeat', capacity, activeRunIds}, runAccepted {type:'run.accepted', runId}, runRejected {type:'run.rejected', runId, reason}, runEvent {type:'run.event', event: OfficeEventSchema}, runResult {type:'run.result', runId, sessionId, result: RunResultSchema} ])`; `ApiToWorkerSchema = z.discriminatedUnion('type', [ welcome {type:'welcome', workerId, credential?: string}, runAssign {type:'run.assign', spec: RunSpecSchema}, runCancel {type:'run.cancel', runId}, error {type:'error', message} ])`.

- [ ] **Step 1: Write failing tests**

`task-state.test.ts`:
```ts
it('allows the happy path', () => {
  expect(transitionTask('ready', 'queued')).toBe('queued');
  expect(transitionTask('queued', 'running')).toBe('running');
  expect(transitionTask('running', 'review')).toBe('review');
  expect(transitionTask('review', 'done')).toBe('done');
});
it('allows running -> waiting_reply -> running and running -> waiting_approval -> running', ...)
it('allows running -> ready (lease lost, retry) and running -> failed', ...)
it('allows planned -> ready and planned -> blocked and ready -> cancelled', ...)
it('rejects done -> running and failed -> done and ready -> done', () => {
  expect(() => transitionTask('done', 'running')).toThrow(InvalidTransitionError);
  ...
});
it('every status appears as a key in TASK_TRANSITIONS', ...)
```
`events.test.ts`: `OfficeEventSchema` rejects `seq: 0`, rejects unknown `type`, accepts a full valid event; `WorkerToApiSchema` parses a `run.event` message and rejects `type: 'nope'`.

- [ ] **Step 2: Run tests, verify fail**

Run: `pnpm --filter @office/shared test`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement the five modules**

`TASK_TRANSITIONS` encodes spec §8.2: `planned→[ready,blocked,cancelled]`, `ready→[queued,cancelled,blocked]`, `queued→[running,ready,cancelled]`, `running→[waiting_reply,waiting_approval,review,failed,cancelled,ready]`, `waiting_reply→[running,failed,cancelled]`, `waiting_approval→[running,failed,cancelled]`, `review→[done,running,failed]`, `blocked→[ready,cancelled]`, `done→[]`, `failed→[ready]`, `cancelled→[]`. (`failed→ready` exists for an explicit owner retry.)

- [ ] **Step 4: Run tests, verify pass**

Run: `pnpm --filter @office/shared test && pnpm --filter @office/shared build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared && git commit -m "feat(shared): enums, task state machine, event and worker protocol schemas"
```

---

### Task 3: Database package — Prisma 7 schema, migration, client

**Files:**
- Create: `packages/db/package.json`, `packages/db/tsconfig.json`, `packages/db/prisma.config.ts`, `packages/db/prisma/schema.prisma`, `packages/db/src/index.ts`, `packages/db/vitest.config.ts`
- Create: `packages/db/prisma/migrations/<timestamp>_init/migration.sql` (generated)
- Test: `packages/db/src/client.test.ts`

**Interfaces:**
- Produces: `createPrisma(connectionString: string): PrismaClient` and `export type { PrismaClient }` plus `export * from './generated/prisma/client.js'` (model types and enums). Scripts: `generate: prisma generate`, `migrate:dev: prisma migrate dev`, `migrate:deploy: prisma migrate deploy`, `migrate:test: DATABASE_URL=$DATABASE_URL_TEST prisma migrate deploy`.
- Schema (Phase 1 subset of spec §15; every model has `id String @id @default(uuid())`, `createdAt DateTime @default(now())`; every FK indexed):
  - `User(email unique, passwordHash)`; `UserSession(token unique, userId, expiresAt)`
  - `Project(name, slug unique, repoPath, defaultBranch default "main")`
  - `Agent(name, slug unique, role, description, isActive default true, currentVersionId String?)`; `AgentVersion(agentId, version Int, config Json, @@unique([agentId, version]))`
  - `Worker(name, status WorkerStatus default pending, enrollTokenHash String?, credentialHash String?, capacity Int default 1, allowedRoots String[], lastHeartbeatAt DateTime?)`
  - `Task(projectId, agentId, title, description, status TaskStatus default ready, priority Int default 0, maxAttempts Int default 2, attempts Int default 0, updatedAt @updatedAt)`
  - `TaskRun(taskId, kind RunKind default task, agentVersionId, workerId String?, status RunStatus default queued, leaseExpiresAt DateTime?, startedAt DateTime?, finishedAt DateTime?, resultText String?, error String?, costUsd Float default 0)`
  - `AgentSession(runId unique, agentId, projectId, sdkSessionId String?, model, status String, startedAt, endedAt DateTime?, skillsSnapshot Json?)`
  - `SessionEvent(sessionId, seq Int, type, ts DateTime, payload Json, @@unique([sessionId, seq]), @@index([sessionId, seq]))`
  - `UsageRecord(runId, projectId, agentId, model, inputTokens Int, outputTokens Int, costUsd Float)`
  - Prisma enums `TaskStatus`, `RunStatus`, `RunKind`, `WorkerStatus` with the same members as `@office/shared`.
- `AgentVersion.config` JSON shape (validated by `AgentConfigSchema` added to `packages/shared/src/agent-config.ts` in this task): `{ systemPrompt: string, model: string, effort?: string, allowedTools: string[], maxTurns: number (default 50), maxBudgetUsd: number (default 2), maxConcurrentSubagents: number (default 4), maxSubagentDepth: number (default 1) }`.

- [ ] **Step 1: Package and Prisma files**

`prisma.config.ts` exactly as the Prisma 7 generator emits: `import "dotenv/config"; import { defineConfig } from "prisma/config"; export default defineConfig({ schema: "prisma/schema.prisma", migrations: { path: "prisma/migrations" }, datasource: { url: process.env["DATABASE_URL"] } })`. Add `dotenv` as a dev dependency. The package reads `../../.env` by setting `dotenv` path: use `import { config } from "dotenv"; config({ path: new URL("../../.env", import.meta.url).pathname })` instead of `dotenv/config`.

`src/index.ts`: `import { PrismaClient } from './generated/prisma/client.js'; import { PrismaPg } from '@prisma/adapter-pg'; export function createPrisma(connectionString: string) { return new PrismaClient({ adapter: new PrismaPg({ connectionString }) }) }`.

- [ ] **Step 2: Write failing test**

`client.test.ts` (uses `process.env.DATABASE_URL_TEST`):
```ts
it('migrated schema accepts an agent with a version and enforces (agentId, version) uniqueness', async () => {
  const agent = await prisma.agent.create({ data: { name: 'A', slug: `a-${Date.now()}`, role: 'dev', versions: { create: { version: 1, config: {} } } } });
  await expect(prisma.agentVersion.create({ data: { agentId: agent.id, version: 1, config: {} } })).rejects.toThrow();
});
it('rejects duplicate (sessionId, seq) on SessionEvent', ...)
```

- [ ] **Step 3: Generate, migrate, run**

Run: `cp .env.example .env` (if absent) `&& pnpm --filter @office/db generate && pnpm --filter @office/db migrate:dev --name init && pnpm --filter @office/db migrate:test && pnpm --filter @office/db test`
Expected: migration folder created; tests PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/db packages/shared && git commit -m "feat(db): prisma 7 schema and initial migration"
```

---

### Task 4: Runtime package — adapter interface, redaction, fake adapter, Claude adapter

**Files:**
- Create: `packages/runtime/package.json`, `tsconfig.json`, `vitest.config.ts`
- Create: `packages/runtime/src/types.ts`, `src/redact.ts`, `src/fake/adapter.ts`, `src/claude/normalize.ts`, `src/claude/adapter.ts`, `src/claude/env.ts`, `src/index.ts`
- Create: `packages/runtime/scripts/smoke-claude.ts` (opt-in, real Claude)
- Test: `src/redact.test.ts`, `src/fake/adapter.test.ts`, `src/claude/normalize.test.ts`, `src/claude/env.test.ts`, fixtures `src/claude/__fixtures__/sdk-messages.json`

**Interfaces:**
- Consumes: `RunSpec`, `RunResult`, `EventBody` from `@office/shared`.
- Produces (`types.ts`): `interface EventSink { emit(body: EventBody): void }`; `interface RuntimeAdapter { readonly name: 'claude' | 'fake'; run(spec: RunSpec, sink: EventSink, signal: AbortSignal): Promise<RunResult> }`.
- Produces (`redact.ts`): `redactSecrets<T>(value: T): T` deep-copies strings in objects/arrays replacing matches of: `sk-ant-[A-Za-z0-9_-]{20,}`, `ghp_[A-Za-z0-9]{36}`, `AKIA[0-9A-Z]{16}`, `xox[baprs]-[A-Za-z0-9-]{10,}`, `-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----`, and `(?i)\b(api[_-]?key|secret|token|password|passwd)\b(["']?\s*[:=]\s*["']?)([^\s"'\\]{8,})` (keeps group 1 and 2, replaces group 3) with `[REDACTED]`.
- Produces (`fake/adapter.ts`): `class FakeAdapter implements RuntimeAdapter`. Behaviour: emits `agent.started {model}`, `agent.text {text: 'fake: ' + spec.prompt}`, `agent.tool.started {tool:'Bash', toolUseId:'fake-1', input:{command:'echo ok'}}`, `agent.tool.completed {toolUseId:'fake-1', output:'ok'}`, then if `spec.prompt` includes `FAIL` emits `agent.failed {error:'fake failure'}` and returns `status:'failed', error:'fake failure'`; else emits `agent.completed {resultText}` and returns `status:'succeeded', resultText: 'fake result for: ' + spec.prompt, sdkSessionId: 'fake-' + spec.sessionId`, usage all zeros except `numTurns: 1`. Honors `signal`: if aborted before completion returns `status:'cancelled'` and emits `agent.cancelled`. If `spec.prompt` includes `SLOW`, waits 2000 ms before completing (used by lease tests).
- Produces (`claude/env.ts`): `buildChildEnv(base: NodeJS.ProcessEnv, spec: Pick<RunSpec,'maxConcurrentSubagents'|'maxSubagentDepth'>): Record<string,string>` applying the Global Constraints rule.
- Produces (`claude/normalize.ts`): `normalizeSdkMessage(msg: SDKMessage): EventBody[]` mapping: `system/init` → `agent.started {model, tools, sdkSessionId}`; assistant `text` blocks → `agent.text {text}`; assistant `thinking` blocks → `agent.thinking {chars: length}` (never the content); assistant `tool_use` → `agent.tool.started {toolUseId, tool, input}` and additionally `agent.subagent.spawned {toolUseId, description, subagentType}` when `tool === 'Agent' || tool === 'Task'`; user `tool_result` → `agent.tool.completed {toolUseId, output}` or `agent.tool.failed` when `is_error`; `tool_use` named `Edit|Write|MultiEdit|NotebookEdit` additionally → `agent.file.changed {path}`; `tool_use` named `Bash` additionally → `agent.command.executed {command}`; messages with `parent_tool_use_id` set get `payload.parentToolUseId`; `SDKTaskNotificationMessage`-shaped messages → `agent.subagent.completed {toolUseId, status, summary}`; `result` → `agent.completed {resultText, costUsd, numTurns, durationMs}` on `subtype === 'success'`, else `agent.failed {subtype, errors}`. Payloads are passed through `redactSecrets`. Unknown message types → `[]`.
- Produces (`claude/adapter.ts`): `class ClaudeAdapter implements RuntimeAdapter` calling `query({ prompt: spec.prompt, options: { cwd: spec.cwd, model: spec.model, effort: spec.effort, systemPrompt: spec.systemPrompt, allowedTools: spec.allowedTools, permissionMode: 'default', maxTurns: spec.maxTurns, maxBudgetUsd: spec.maxBudgetUsd, settingSources: ['project'], resume: spec.resumeSdkSessionId, env: buildChildEnv(process.env, spec), abortController, canUseTool: async (toolName) => spec.allowedTools.includes(toolName) ? { behavior: 'allow' } : { behavior: 'deny', message: 'Tool not permitted by Agent Office policy' } } })`, emitting `normalizeSdkMessage` output for each message and converting the `result` message into `RunResult` (`usage.costUsd = total_cost_usd`, tokens from `usage.input_tokens`/`output_tokens`, `sdkSessionId = session_id`). Note: `allowedTools` auto-approves listed tools; `canUseTool` is the deny path for everything else.
- `src/index.ts`: `export function createAdapter(name: 'claude' | 'fake'): RuntimeAdapter`.

- [ ] **Step 1: Write failing tests**

`redact.test.ts`: an object `{ out: 'key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789 end', nested: ['AKIAABCDEFGHIJKLMNOP'], cfg: 'password=hunter2hunter2' }` → every secret replaced by `[REDACTED]`, `cfg` becomes `'password=[REDACTED]'`, non-secret text unchanged, input object not mutated.

`fake/adapter.test.ts`: success emits exactly the five event types in order and returns `succeeded` with `resultText` containing the prompt; `FAIL` prompt returns `failed` and last event is `agent.failed`; aborting the signal during a `SLOW` prompt returns `cancelled`.

`claude/env.test.ts`: `buildChildEnv({ CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'x', AI_AGENT: '1', PATH: '/bin', HOME: '/h' }, { maxConcurrentSubagents: 3, maxSubagentDepth: 1 })` equals `{ PATH: '/bin', HOME: '/h', CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: '3', CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: '1' }`.

`claude/normalize.test.ts` over the fixture file (hand-written minimal SDK messages: init, assistant with text + tool_use Bash, user tool_result, assistant tool_use Agent, task notification, result success, result error_max_turns): asserts event types per message, that `thinking` never leaks content, that a `tool_result` containing `sk-ant-...` is redacted, that Bash yields both `agent.tool.started` and `agent.command.executed`.

- [ ] **Step 2: Run tests, verify fail**

Run: `pnpm --filter @office/runtime test`
Expected: FAIL.

- [ ] **Step 3: Implement**

Install `@anthropic-ai/claude-agent-sdk@^0.3.316` as a dependency of `@office/runtime`. Type the normalizer against `SDKMessage` from the SDK; where the SDK type is too loose for the fixture, narrow with small local type guards rather than `any`.

- [ ] **Step 4: Run tests, verify pass**

Run: `pnpm --filter @office/runtime test && pnpm --filter @office/runtime build`
Expected: PASS.

- [ ] **Step 5: Real Claude smoke (opt-in, not part of `pnpm test`)**

`scripts/smoke-claude.ts`: builds a `RunSpec` with `cwd = os.tmpdir()`, `prompt = 'Reply with exactly: RUNTIME_OK'`, `model = 'haiku'`, `allowedTools = []`, `maxTurns = 1`, `maxBudgetUsd = 0.05`, runs `ClaudeAdapter`, prints each event type and the `RunResult`.

Run: `pnpm --filter @office/runtime exec tsx scripts/smoke-claude.ts`
Expected: events `agent.started`, `agent.text`, `agent.completed`; result `succeeded`, `resultText` contains `RUNTIME_OK`, `costUsd > 0`. Record the observed output in `docs/progress.md` under "Evidence".

- [ ] **Step 6: Commit**

```bash
git add packages/runtime docs/progress.md && git commit -m "feat(runtime): adapter interface, redaction, fake adapter, Claude adapter with event normalization"
```

---

### Task 5: API core — config, app builder, auth, projects, agents with versions

**Files:**
- Create: `apps/api/package.json`, `tsconfig.json`, `vitest.config.ts`
- Create: `apps/api/src/config.ts`, `src/app.ts`, `src/server.ts`, `src/plugins/prisma.ts`, `src/plugins/auth.ts`, `src/routes/health.ts`, `src/routes/auth.ts`, `src/routes/projects.ts`, `src/routes/agents.ts`, `src/lib/password.ts`, `src/lib/errors.ts`
- Test: `apps/api/test/helpers.ts`, `test/auth.test.ts`, `test/agents.test.ts`

**Interfaces:**
- Consumes: `createPrisma` from `@office/db`; `AgentConfigSchema` from `@office/shared`.
- Produces (`config.ts`): `loadConfig(env = process.env): Config` with `{ databaseUrl, port (default 4000), cookieSecret (min 32 chars, throws otherwise), webOrigin, dataDir, leaseSeconds: 60, heartbeatSeconds: 10, schedulerIntervalMs: 2000 }`.
- Produces (`app.ts`): `buildApp(config: Config, deps?: { prisma?: PrismaClient }): Promise<FastifyInstance>` registering cors (`origin: config.webOrigin, credentials: true`), cookie, websocket, prisma decorator, auth hook, all routes. `app.prisma` typed via module augmentation.
- Produces (`plugins/auth.ts`): `onRequest` hook; public paths `/health`, `/auth/setup`, `/auth/login`, `/ws/worker`; everything else requires cookie `office_session` whose value is a `UserSession.token` with `expiresAt > now`; sets `request.user = { id, email }`. 401 JSON `{ error: 'unauthorized' }` otherwise.
- Routes (all bodies validated with Zod; errors `{ error: string, details? }` with 400/401/404/409):
  - `GET /health` → `{ ok: true }`
  - `POST /auth/setup {email, password (min 8)}` → 201 `{ id, email }`, sets cookie; 409 if any user exists.
  - `POST /auth/login {email, password}` → 200 sets cookie (`httpOnly`, `sameSite: 'lax'`, `path: '/'`, 30 days); 401 on mismatch.
  - `POST /auth/logout` → deletes session, clears cookie. `GET /auth/me` → `{ id, email, setupRequired: false }`; special case: `GET /auth/me` is public and returns `{ setupRequired: true }` with 200 when no users exist.
  - `GET /projects`, `POST /projects {name, slug, repoPath, defaultBranch?}` → 201; `GET /projects/:id`.
  - `GET /agents` (each with `currentVersion`), `POST /agents {name, slug, role, description?, config: AgentConfig}` → creates Agent + AgentVersion 1 and sets `currentVersionId`; `GET /agents/:id` (with all versions); `PUT /agents/:id {name?, role?, description?, isActive?, config?}` → if `config` present creates version N+1 and updates `currentVersionId`; returns agent with `currentVersion`.
- Passwords: `argon2.hash` / `argon2.verify`.
- `test/helpers.ts`: `makeApp()` builds the app against `DATABASE_URL_TEST`, truncates all tables (`TRUNCATE ... CASCADE` over a fixed table list) before each test file, and returns `{ app, prisma, login(): Promise<string /* cookie header */> }` where `login` runs setup with `owner@example.com` / `password123` and returns the `Cookie` header value.

- [ ] **Step 1: Write failing tests**

`auth.test.ts`: `GET /auth/me` → `{ setupRequired: true }`; `POST /auth/setup` → 201 and a `set-cookie` containing `office_session`; second setup → 409; `GET /projects` without cookie → 401; with cookie → 200 `[]`; wrong password login → 401.

`agents.test.ts`: `POST /agents` with config `{ systemPrompt: 'x', model: 'sonnet', allowedTools: ['Read'] }` → 201, `currentVersion.version === 1`, config defaults filled (`maxTurns: 50`, `maxBudgetUsd: 2`); `PUT /agents/:id` with a new `systemPrompt` → `currentVersion.version === 2` and `GET /agents/:id` lists two versions with version 1 unchanged; `PUT` with only `name` → still version 2 (no new version); `POST` with invalid config (`allowedTools: 'Read'`) → 400.

- [ ] **Step 2: Run tests, verify fail**

Run: `pnpm --filter @office/api test`
Expected: FAIL.

- [ ] **Step 3: Implement**

Dependencies: `fastify@^5`, `@fastify/cors@^11`, `@fastify/cookie@^11`, `@fastify/websocket@^11`, `argon2@^0.45`, `pino@^10`, `zod@^4`, workspace `@office/db`, `@office/shared`, `@office/runtime` (for types only in later tasks). Dev: `vitest`, `tsx`, `@types/node`. Scripts: `dev: tsx watch src/server.ts`, `build: tsc -p tsconfig.json`, `test: vitest run`, `typecheck`.

`server.ts`: `loadConfig()`, `buildApp`, `listen({ port, host: '0.0.0.0' })`, log with pino.

- [ ] **Step 4: Run tests, verify pass**

Run: `pnpm --filter @office/api test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api && git commit -m "feat(api): fastify app, cookie auth, projects, agents with immutable versions"
```

---

### Task 6: API tasks, runs, scheduler, leases, worker WebSocket

**Files:**
- Create: `apps/api/src/routes/tasks.ts`, `src/routes/runs.ts`, `src/routes/workers.ts`, `src/services/task-service.ts`, `src/services/run-service.ts`, `src/services/scheduler.ts`, `src/services/event-store.ts`, `src/services/event-hub.ts`, `src/ws/worker-gateway.ts`, `src/lib/tokens.ts`
- Modify: `apps/api/src/app.ts` (register routes, gateway, scheduler start/stop)
- Test: `apps/api/test/fake-worker.ts`, `test/tasks.test.ts`, `test/scheduler.test.ts`, `test/worker-gateway.test.ts`

**Interfaces:**
- Consumes: `transitionTask`, `OfficeEventSchema`, `WorkerToApiSchema`, `ApiToWorkerSchema`, `RunSpecSchema` from `@office/shared`; `redactSecrets` from `@office/runtime`.
- Produces (`services/event-hub.ts`): in-process `EventHub` with `publish(topic: string, message: unknown)`, `subscribe(topic, fn): () => void`. Topics: `run:<runId>`, `task:<taskId>`, `global`.
- Produces (`services/event-store.ts`): `appendEvent(prisma, event: OfficeEvent): Promise<{ inserted: boolean }>` — redacts payload, inserts `SessionEvent`, swallows unique-violation (P2002) as `inserted: false`; `listEvents(prisma, sessionId, afterSeq = 0, limit = 1000): Promise<OfficeEvent[]>` ordered by `seq`.
- Produces (`services/task-service.ts`): `createTask(prisma, { projectId, agentId, title, description, priority? })` → Task with status `ready` (Phase 1: no dependencies); `setTaskStatus(prisma, taskId, to)` uses `transitionTask` and publishes `task.status.changed` on `task:<id>` and `global`; `cancelTask(prisma, hub, gateway, taskId)` → cancels active run (`run.cancel` to worker) and sets `cancelled`.
- Produces (`services/run-service.ts`): `createRunForTask(prisma, task, worker, config: Config)` → creates `TaskRun {status:'queued', workerId, leaseExpiresAt: now + leaseSeconds}` + `AgentSession {model from agent version config, status:'starting'}` + task `attempts + 1`, task → `queued`, returns `{ run, session, spec: RunSpec }` where `spec.prompt = task.title + '\n\n' + task.description`, `spec.cwd = project.repoPath`, other fields from `AgentVersion.config`; `markRunning(runId)`; `renewLeases(prisma, workerId, runIds, config)` → extends `leaseExpiresAt` for runs owned by that worker and still `running|queued`; `completeRun(prisma, hub, { runId, workerId, result })` → verifies `run.workerId === workerId && run.status in (queued, running) && leaseExpiresAt > now` else throws `LeaseError`; writes result, `UsageRecord`, session `ended`, task → `review` → `done` on `succeeded` (Phase 1 auto-closes review; the Chief takes over in Phase 4), task → `failed` on `failed`, task → `cancelled` on `cancelled`; `expireLeases(prisma, hub, now)` → every run with `status in (queued, running)` and `leaseExpiresAt < now` becomes `lost`, publishes `run.lease.lost`, task goes `running→ready` if `attempts < maxAttempts` else `failed`.
- Produces (`services/scheduler.ts`): `class Scheduler { constructor(prisma, hub, gateway, config); start(); stop(); tick(): Promise<void> }`. `tick`: `expireLeases`, then for each `ready` task ordered by `priority desc, createdAt asc`: pick an online worker from `gateway.onlineWorkers()` whose `capacity - activeRuns > 0` and whose `allowedRoots` contains a prefix of `project.repoPath` (path-segment prefix, not string prefix); if found, `createRunForTask` and `gateway.send(workerId, { type: 'run.assign', spec })`. Skip silently otherwise.
- Produces (`ws/worker-gateway.ts`): `class WorkerGateway` registered at `GET /ws/worker` (websocket). Handles `hello`: with `enrollToken` → finds Worker whose `enrollTokenHash === sha256(token)` and `status === 'pending'`, generates `credential` (32 random bytes base64url), stores `credentialHash`, clears `enrollTokenHash`, replies `welcome {workerId, credential}`; with `credential` → matches `credentialHash` of a non-revoked worker, replies `welcome {workerId}`; otherwise `error` and close. On hello also updates `name, capacity, allowedRoots, status: 'online', lastHeartbeatAt` and, for each `activeRunIds` entry that matches a `running` run of this worker, renews its lease (reattach). `heartbeat` → `lastHeartbeatAt`, `renewLeases`. `run.accepted` → `markRunning`, publish `run.status.changed`. `run.event` → verifies the event's `runId` belongs to this worker with a live lease, else drops with a log line; `appendEvent`; `hub.publish('run:<runId>', event)`. `run.result` → `completeRun`; on `LeaseError` replies `error {message}` and does nothing else. On close → worker `offline`; runs are left to `expireLeases`. `onlineWorkers(): Array<{ workerId, capacity, activeRuns, allowedRoots }>`; `send(workerId, msg: ApiToWorker): boolean`.
- Routes:
  - `GET /tasks?projectId=`; `POST /tasks {projectId, agentId, title, description, priority?}` → 201; `GET /tasks/:id` → task with `runs` (each with `session`); `POST /tasks/:id/cancel`.
  - `GET /runs/:id` → run with session; `GET /runs/:id/events?afterSeq=0` → `OfficeEvent[]`.
  - `GET /workers`; `POST /workers {name}` → 201 `{ id, enrollToken }` (token shown once; only the sha256 stored); `DELETE /workers/:id` → status `revoked`, closes its socket.
- `test/fake-worker.ts`: `connectFakeWorker(app, { enrollToken | credential, name, capacity, allowedRoots })` opens a `ws` client to the app's address, sends `hello`, resolves `{ workerId, credential, received: ApiToWorker[], send(msg), waitFor(type), close() }`.

- [ ] **Step 1: Write failing tests**

`tasks.test.ts`: `POST /tasks` → 201 with `status: 'ready'`; `GET /tasks/:id` includes `runs: []`; cancel a `ready` task → `cancelled`.

`worker-gateway.test.ts`: enroll with token → `welcome` carries `credential`, worker row `online`, `enrollTokenHash` null; reconnect with credential → `welcome` without credential; bad credential → `error` then socket closes; revoked worker cannot connect.

`scheduler.test.ts` (uses `scheduler.tick()` directly, no timers):
- creates project (`repoPath: '/tmp/office-ws/p1'`), agent, task, connects fake worker (`allowedRoots: ['/tmp/office-ws']`, capacity 1); `tick()` → worker receives `run.assign` with `spec.prompt` containing the title; task `queued`; run has `leaseExpiresAt`.
- worker with `allowedRoots: ['/tmp/other']` receives nothing.
- worker sends `run.accepted` → run `running`, task `running`; sends 3 `run.event` → `GET /runs/:id/events` returns 3 in `seq` order; re-sends event `seq 2` → still 3 rows, no `error` message received.
- event payload `{ output: 'token=abcdefghijklmnop' }` sent unredacted → stored payload has `token=[REDACTED]`.
- `run.result succeeded` → task `done`, run `succeeded`, `UsageRecord` exists.
- lease: set `leaseExpiresAt` to the past via prisma, `tick()` → run `lost`, task `ready`, `attempts 1`; assign again and lose again → task `failed`.
- after the lease is lost, the old worker's `run.result` for that run → `error` reply, task still `ready`.
- capacity: capacity 1 worker with one running run receives no second assignment; after completion it does.

- [ ] **Step 2: Run tests, verify fail**

Run: `pnpm --filter @office/api test`
Expected: FAIL.

- [ ] **Step 3: Implement**

Scheduler uses `setInterval(config.schedulerIntervalMs)` with an in-flight guard; `app.addHook('onClose')` stops it. Tests construct the app with `schedulerIntervalMs: 0` meaning "do not start the timer".

- [ ] **Step 4: Run tests, verify pass**

Run: `pnpm --filter @office/api test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api && git commit -m "feat(api): tasks, runs, leases, scheduler, worker websocket gateway"
```

---

### Task 7: API UI WebSocket with replay

**Files:**
- Create: `apps/api/src/ws/ui-gateway.ts`
- Modify: `apps/api/src/app.ts`
- Test: `apps/api/test/ui-gateway.test.ts`

**Interfaces:**
- Produces: `GET /ws/ui` (websocket, cookie-authenticated on upgrade; unauthenticated → close code 4401). Client → server messages: `{ type: 'subscribe', topic: 'run:<runId>' | 'task:<taskId>' | 'global', afterSeq?: number }`, `{ type: 'unsubscribe', topic }`. Server → client: `{ type: 'event', topic, event: OfficeEvent }` for run topics; `{ type: 'task.status.changed', topic, task: { id, status, updatedAt } }` for task/global; `{ type: 'replay.done', topic, lastSeq }` after replay. Replay for `run:<id>`: `listEvents(sessionId, afterSeq)` sent first, then live; live events with `seq <= lastSeq` already sent are dropped so reconnects never duplicate. Schemas `UiClientMessageSchema` and `UiServerMessageSchema` added to `packages/shared/src/protocol.ts`.

- [ ] **Step 1: Write failing tests**

`ui-gateway.test.ts`: connect without cookie → closed with 4401; subscribe to `run:<id>` after the fake worker sent events `1..3` → client receives 3 events then `replay.done lastSeq 3`; worker sends `seq 4` live → client receives it once; reconnect with `afterSeq: 2` → receives `3, 4` only; a live `seq 3` re-sent by the worker during replay → not delivered twice; `global` subscriber receives `task.status.changed` when a run completes.

- [ ] **Step 2: Run tests, verify fail**

Run: `pnpm --filter @office/api test test/ui-gateway.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** `UiGateway` using `EventHub.subscribe`; per-connection `Map<topic, { unsubscribe, lastSeq }>`.

- [ ] **Step 4: Run tests, verify pass**

Run: `pnpm --filter @office/api test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api packages/shared && git commit -m "feat(api): ui websocket with sequence replay"
```

---

### Task 8: Worker application

**Files:**
- Create: `apps/worker/package.json`, `tsconfig.json`, `vitest.config.ts`
- Create: `apps/worker/src/config.ts`, `src/credentials.ts`, `src/connection.ts`, `src/executor.ts`, `src/main.ts`
- Test: `apps/worker/test/executor.test.ts`, `apps/worker/test/e2e-fake.test.ts`

**Interfaces:**
- Consumes: `createAdapter` from `@office/runtime`; protocol schemas from `@office/shared`; `buildApp` and `test/fake-worker.ts` patterns from `apps/api` (the e2e test imports `buildApp` via workspace dependency `@office/api` dev-only, exporting `buildApp` from `apps/api/src/app.ts` through `apps/api/package.json` `exports`).
- Produces (`config.ts`): `loadWorkerConfig(env)`: `{ apiUrl (OFFICE_API_URL), home (OFFICE_WORKER_HOME, `~` expanded), enrollToken (OFFICE_ENROLL_TOKEN?), workspaceRoots (OFFICE_WORKSPACE_ROOTS split on ':', each resolved to an absolute real path), runtime ('claude' | 'fake' from OFFICE_RUNTIME, default 'claude'), capacity (OFFICE_WORKER_CAPACITY, default 2), name (OFFICE_WORKER_NAME, default os.hostname()) }`.
- Produces (`credentials.ts`): `loadCredential(home): Promise<string | null>`, `saveCredential(home, credential)` at `<home>/credentials.json` mode `0600`.
- Produces (`executor.ts`): `class RunExecutor { constructor(adapter: RuntimeAdapter, send: (msg: WorkerToApi) => void, workspaceRoots: string[]); accept(spec: RunSpec): void; cancel(runId: string): void; activeRunIds(): string[] }`. `accept`: rejects with `run.rejected {reason:'cwd outside allowed roots'}` unless `spec.cwd` resolves under one of `workspaceRoots` (segment-wise); otherwise sends `run.accepted`, runs the adapter with an `AbortController`, wraps each `EventBody` into an `OfficeEvent` with `seq` starting at 1 per session, `ts = new Date().toISOString()`, ids from the spec, applies `redactSecrets`, sends `run.event`; on finish sends `run.result`. Adapter exceptions become `run.result {status:'failed', error: message}` after emitting `agent.failed`.
- Produces (`connection.ts`): `class WorkerConnection { constructor(config, executor factory); start(): Promise<void>; stop(): Promise<void> }`: connects `ws` to `${apiUrl}/ws/worker`; sends `hello` with credential if saved else enrollToken; on `welcome` with credential saves it; heartbeat every 10 s with `activeRunIds`; dispatches `run.assign` → `executor.accept`, `run.cancel` → `executor.cancel`; reconnects with exponential backoff (1 s → 30 s) and re-sends `hello` with current `activeRunIds` (reattach). Logs with pino.
- `main.ts`: load config, `createAdapter(config.runtime)`, start connection, handle SIGINT/SIGTERM → cancel active runs, close.

- [ ] **Step 1: Write failing tests**

`executor.test.ts` (FakeAdapter, captured `send`): accept → messages in order `run.accepted`, five `run.event` with `seq 1..5` and matching `runId/sessionId`, `run.result succeeded`; cwd outside roots → single `run.rejected`; `cancel` during a `SLOW` prompt → `run.result cancelled`.

`e2e-fake.test.ts`: boot `buildApp` on an ephemeral port against `DATABASE_URL_TEST`; create owner, project (`repoPath` = a temp dir under a temp root), agent, worker (enroll token); start `WorkerConnection` with `runtime: 'fake'`, `workspaceRoots: [tempRoot]`; `POST /tasks`; call `scheduler.tick()`; poll `GET /tasks/:id` until `done` (timeout 10 s); assert `GET /runs/:id/events` has `agent.started` first and `agent.completed` last, `run.resultText` contains the title, `UsageRecord` row exists, worker row `online`. Second part: stop the worker process mid-run (`SLOW` task), set the lease into the past, `tick()` → task `ready`; restart connection → task completes on the second attempt with `attempts === 2`.

- [ ] **Step 2: Run tests, verify fail**

Run: `pnpm --filter @office/worker test`
Expected: FAIL.

- [ ] **Step 3: Implement**

Dependencies: `ws@^8`, `@types/ws`, `pino`, workspace `@office/shared`, `@office/runtime`; dev `@office/api`, `@office/db`. Scripts `dev: tsx watch src/main.ts`, `start: node dist/main.js`, `build`, `test`, `typecheck`.

- [ ] **Step 4: Run tests, verify pass**

Run: `pnpm --filter @office/worker test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/worker apps/api/package.json && git commit -m "feat(worker): outbound connection, enrollment, lease heartbeat, run executor"
```

---

### Task 9: Web application (minimal)

**Files:**
- Create: `apps/web/` via `pnpm create next-app@latest apps/web --ts --tailwind --app --eslint --src-dir --import-alias "@/*" --use-pnpm --no-turbopack` then `pnpm dlx shadcn@latest init -d` and `add button input card badge table textarea label`
- Create: `apps/web/src/lib/api.ts`, `src/lib/ws.ts`, `src/lib/queries.ts`, `src/components/providers.tsx`, `src/components/nav.tsx`, `src/components/event-log.tsx`
- Create pages: `src/app/login/page.tsx`, `src/app/page.tsx` (dashboard), `src/app/tasks/new/page.tsx`, `src/app/tasks/[id]/page.tsx`, `src/app/workers/page.tsx`, `src/app/agents/page.tsx`
- Test: `apps/web/src/lib/ws.test.ts`

**Interfaces:**
- Consumes: API routes from Tasks 5–7; `UiServerMessageSchema`, `OfficeEvent` from `@office/shared`.
- Produces (`lib/api.ts`): `api<T>(path: string, init?: RequestInit): Promise<T>` using `NEXT_PUBLIC_API_URL`, `credentials: 'include'`, throws `ApiError(status, body)`; on 401 redirects to `/login` (client side).
- Produces (`lib/ws.ts`): `class UiSocket { constructor(url: string); subscribe(topic: string, afterSeq: number, onMessage: (m: UiServerMessage) => void): () => void }` with auto-reconnect that re-subscribes every topic using the highest `seq` seen per topic. Pure logic (`nextAfterSeq(topicState, message)`) unit-tested without a browser.
- Pages: `/login` (setup when `GET /auth/me` says `setupRequired`, otherwise login). `/` dashboard: three cards (online workers count, tasks by status counts, last 10 tasks table with status badge linking to `/tasks/[id]`). `/tasks/new`: selects for project and agent, title, description, submit → redirect to task page. `/tasks/[id]`: header (title, status badge, agent, attempts), runs list, live event log for the latest run (replay then live via `UiSocket`), result text or error, cancel button while active. `/workers`: table (name, status, capacity, last heartbeat) and "Add worker" that shows the enroll token once with the exact command `OFFICE_ENROLL_TOKEN=<token> pnpm --filter @office/worker dev`. `/agents`: table of agents with current version number and model; create form with name, slug, role, system prompt, model select (`fable`, `opus`, `sonnet`, `haiku`), allowed tools (comma-separated; default `Read,Glob,Grep,Bash,Edit,Write`).
- `event-log.tsx`: monospace list; each row `seq`, time, type badge, one-line summary (`tool` + first 80 chars of `input.command` or `path`; `text` first 120 chars); click expands the JSON payload.
- Dark theme: shadcn `dark` class on `<html>`.

- [ ] **Step 1: Scaffold and write the `ws.test.ts` failing test**

`nextAfterSeq` returns the max seq seen for a run topic and ignores non-event messages; re-subscribe payload after reconnect uses it.

- [ ] **Step 2: Run, verify fail** — `pnpm --filter @office/web test`.

- [ ] **Step 3: Implement pages and libs**

Set `apps/web/package.json` name to `@office/web`, add `@tanstack/react-query@^5`, workspace `@office/shared`; `transpilePackages: ['@office/shared']` in `next.config.ts`. `.env.local` not committed; `NEXT_PUBLIC_API_URL` read from root `.env` through `next.config.ts` `env` passthrough is not needed since Next reads `.env` in its own dir: add `apps/web/.env.example` with `NEXT_PUBLIC_API_URL=http://localhost:4000`.

- [ ] **Step 4: Verify**

Run: `pnpm --filter @office/web test && pnpm --filter @office/web build`
Expected: PASS, build exits 0.

Manual: `pnpm dev` (api, worker with `OFFICE_RUNTIME=fake`, web). Browser: setup owner, create project pointing at a directory under `OFFICE_WORKSPACE_ROOTS`, create agent, add worker, start worker with the enroll token, submit task, watch events appear, task reaches `done`. Record in `docs/progress.md`.

- [ ] **Step 5: Commit**

```bash
git add apps/web && git commit -m "feat(web): login, dashboard, tasks, live event log, workers, agents"
```

---

### Task 10: Dev scripts, seed, docs, real Claude acceptance

**Files:**
- Create: `packages/db/src/seed.ts` (script `seed`), `scripts/dev-all.sh`
- Create: `README.md`, `docs/architecture.md`, `docs/worker-protocol.md`, `docs/development.md`, `docs/security.md`
- Modify: `docs/progress.md`, `CLAUDE.md`, root `package.json` (script `seed`)

**Interfaces:**
- `seed.ts`: idempotent by slug. Creates project `office-sandbox` with `repoPath = <OFFICE_WORKSPACE_ROOTS first entry>/office-sandbox` (creates the directory and `git init` if missing) and agent `developer` with config `{ systemPrompt: <two paragraphs: role, "inspect before changing", "report what you did">, model: 'sonnet', allowedTools: ['Read','Glob','Grep','Bash','Edit','Write'], maxTurns: 30, maxBudgetUsd: 1 }`. Prints what it created.
- `README.md` sections exactly as spec §20 items 1–12 (items 7–9 via the UI pages of Task 9; 10 and 12 marked "Phase 3" / "Phase 5" with a pointer to `docs/progress.md`). Claude auth section: "the worker inherits the machine's Claude Code login (`claude login`) or `ANTHROPIC_API_KEY`; nothing is configured in Agent Office itself."
- `docs/worker-protocol.md`: every message of `WorkerToApiSchema`/`ApiToWorkerSchema` and `UiClientMessageSchema`/`UiServerMessageSchema` with one line each, the lease rules (60 s, heartbeat 10 s, reattach on hello), and the rejection rules from Review Focus 1–2.
- `docs/architecture.md`: the §5 diagram in text, the run lifecycle (ready → assign → accepted → events → result → review → done), where each spec entity lives today and which are Phase 2+.
- `docs/security.md`: auth model, worker credential, workspace roots, redaction, `permissionMode: 'default'`, what is not yet enforced (approvals, budgets) with phase references.

- [ ] **Step 1: Seed and scripts**

Run: `pnpm seed`
Expected: prints project and agent ids; second run prints "exists" and changes nothing.

- [ ] **Step 2: Real Claude acceptance run**

Start `pnpm infra:up`, `pnpm --filter @office/api dev`, `OFFICE_RUNTIME=claude pnpm --filter @office/worker dev` (with a saved credential), `pnpm --filter @office/web dev`. In the UI submit to `developer` on `office-sandbox`: title `Create hello.txt`, description `Create a file named hello.txt in the current directory containing the single line "Hello from Agent Office", then show its contents with cat.` Expected in the UI: `agent.started`, at least one `agent.tool.started` for `Write` with `agent.file.changed {path: .../hello.txt}`, a `Bash` `agent.command.executed`, `agent.completed` with `costUsd > 0`; task `done`; the file exists on disk. Restart the API process and reload the task page: the same events replay from the database.

Record in `docs/progress.md` → "Phase 1 evidence": run id, session id, event count, cost, file hash, timestamp. If the run fails, record the failure verbatim instead and leave Phase 1 marked incomplete.

- [ ] **Step 3: Docs**

Write the files above. Update `docs/progress.md` Phase 1 → `done` only if Step 2 succeeded; list outstanding items (worktrees, approvals, skills, messaging, memory) under their phases.

- [ ] **Step 4: Full verification**

Run: `pnpm typecheck && pnpm test && pnpm build`
Expected: all exit 0.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "docs: README, architecture, worker protocol, security; seed; phase 1 evidence"
```
