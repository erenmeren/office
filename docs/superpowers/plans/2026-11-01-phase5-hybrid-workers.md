# Phase 5: Hybrid Workers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remote workers that never see the control plane's filesystem run mission tasks from their own clone of the project, coordinated with local workers through leases and the mission branch, surviving disconnects, restarts and lost leases.

**Architecture:** The API becomes the single git endpoint for every project repository (`/git/:projectId/*`, `git http-backend` behind worker-credential bearer auth, a `pre-receive` hook that admits only `refs/heads/office/*` fast-forwards). A remote worker (`canClone`, no local root covering the repo) clones from that endpoint into `<OFFICE_WORKER_HOME>/repos/<projectId>`, works in a worktree of that clone, and integrates by pushing the mission branch with a compare-and-swap (`--force-with-lease`), which races safely against a local worker's `update-ref` CAS on the same repository. Workers declare `tags` and `canClone` in `hello`; the scheduler matches `requiredWorkerTags`, routes runs without a worktree to local workers only, and pins every resume to the worker that holds the SDK session. The worker persists undelivered results to disk so a restart still delivers them. The acceptance runs one local worker on the host and one remote worker in a Docker container.

**Tech Stack:** Fastify 5 (raw stream content-type parser, child_process `git http-backend`), Prisma 7 migration, Zod 4 schemas in `packages/shared`, `ws` worker protocol, Node 22 `child_process` git, Docker Compose service for the remote worker, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-31-agent-office-design.md` §5.2, §8.3, §8.5, §8.6, §11, §14, §17 (Phase 5). Standing decisions: `CLAUDE.md`. Current protocol: `docs/worker-protocol.md`. Phase 4 hand-off: `docs/progress.md` Outstanding.

## Global Constraints

- Remote workers never receive a filesystem path of the control plane: `RunSpec.git.repoPath` is sent only to a worker whose `allowedRoots` cover it; a remote worker gets `RunSpec.git.remote = { path: '/git/<projectId>' }` and nothing else (§11).
- The git endpoint accepts only the worker credential as `Authorization: Bearer <credential>`; user session cookies are never accepted there, worker credentials are never accepted elsewhere (§14). The credential never appears in logs, events, git config files or URLs.
- The endpoint serves only the repository resolved from the `projectId` in the database; no client-supplied path reaches the filesystem.
- Pushes to the endpoint may update only `refs/heads/office/*`, fast-forward only, no deletes, no tags; `refs/heads/<defaultBranch>` is never writable. Nothing is pushed to the project's own `origin` (§8.5).
- Leases, heartbeats and timeouts use API time only; the worker never computes a lease.
- A `waiting_reply` or `waiting_approval` run resumes only on the worker that recorded its SDK session (`TaskRun.workerId`); it is never started on another machine with `resumeSdkSessionId`.
- Runs without `spec.git` (`chat`, `inbox`, `summary`, non-mission `task`) are assigned only to workers whose `allowedRoots` cover the repository.
- `permissionMode: 'default'`; the runtime gate and approval policy apply unchanged on remote workers.
- The real env file never enters a clone or worktree; the env template is written into the worktree as in Phase 4 (§8.6).
- Commit messages end with exactly `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- `docs/progress.md` is updated at the end of the phase and whenever a decision changes.
- `apps/api` and `apps/worker` resolve `@office/shared|db|runtime` via `dist`: rebuild those packages before running api/worker tests after changing them.
- Prisma migrations are generated with `prisma migrate diff` and applied with `migrate deploy`; drift SQL that drops the generated `MemoryEntry.search` column or `MemoryEntry_search_idx` is stripped (see `docs/development.md`).

## Review Focus

1. A worker credential that is revoked mid-session must stop working on the git endpoint at the next request; a revoked worker must not be able to fetch or push. Test in Task 2.
2. A push that names `refs/heads/main`, deletes a ref, pushes a tag, or non-fast-forwards `refs/heads/office/x` must be rejected by the hook even when it comes bundled with a valid `office/*` update (atomic rejection). Test in Task 2.
3. A local worker's `update-ref` CAS and a remote worker's `--force-with-lease` push on the same mission branch at the same time: exactly one wins, the other reports `needs_integration`, the mission branch is never overwritten. Test in Task 5 and Task 9.
4. A resume whose pinned worker is offline must wait (run stays parked, no other worker gets it) and, after the reply/approval timeout, fail or retry fresh without `resumeSdkSessionId`; it must never be sent to another worker with a session id that does not exist there. Test in Task 3.
5. A worker killed between the SDK finishing and `run.result` being sent must deliver that result after restart while the lease is live, and the API must reject it with `No live lease` once the run is `lost` (no double counting). Test in Task 6 and Task 9.

---

### Task 1: Shared schemas and database for worker tags, cloning and the git remote

**Files:**
- Modify: `packages/shared/src/protocol.ts` (hello), `packages/shared/src/run-spec.ts` (git.remote), `packages/shared/src/project-settings.ts` (requiredWorkerTags)
- Modify: `packages/db/prisma/schema.prisma` (Worker.tags, Worker.canClone)
- Create: `packages/db/prisma/migrations/<timestamp>_phase5_workers/migration.sql`
- Test: `packages/shared/test/protocol.test.ts` (extend or create), `packages/db/test/schema.test.ts` (extend)

**Interfaces:**
- Produces: `hello` gains `tags: z.array(z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/)).default([])` and `canClone: z.boolean().default(false)`.
- Produces: `RunSpecSchema.git` gains `remote: z.object({ path: z.string().regex(/^\/git\/[0-9a-f-]{36}$/) }).optional()` and `repoPath` becomes `z.string().optional()`; invariant (refined): exactly one of `repoPath` / `remote` is present.
- Produces: `ProjectSettingsSchema.requiredWorkerTags: z.array(<same tag regex>).default([])`.
- Produces: Prisma `Worker.tags String[] @default([])`, `Worker.canClone Boolean @default(false)`.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/shared/test/protocol.test.ts
it('hello defaults tags to [] and canClone to false', () => {
  const h = WorkerToApiSchema.parse({ type: 'hello', name: 'w', capacity: 1, allowedRoots: [], activeRunIds: [] });
  expect(h).toMatchObject({ tags: [], canClone: false });
});
it('hello rejects a tag with uppercase or spaces', () => {
  expect(() => WorkerToApiSchema.parse({ type: 'hello', name: 'w', capacity: 1, allowedRoots: [], activeRunIds: [], tags: ['GPU box'] })).toThrow();
});
it('run spec git needs exactly one of repoPath or remote', () => {
  const base = { defaultBranch: 'main', missionBranch: 'office/x-abc123', taskSlug: 't', committerName: 'a', committerEmail: 'a@example.invalid', agentName: 'dev' };
  expect(() => RunSpecSchema.shape.git.unwrap().parse({ ...base })).toThrow();
  expect(() => RunSpecSchema.shape.git.unwrap().parse({ ...base, repoPath: '/r', remote: { path: '/git/00000000-0000-0000-0000-000000000000' } })).toThrow();
  expect(RunSpecSchema.shape.git.unwrap().parse({ ...base, remote: { path: '/git/00000000-0000-0000-0000-000000000000' } }).remote?.path).toMatch(/^\/git\//);
});
it('project settings default requiredWorkerTags to []', () => {
  expect(ProjectSettingsSchema.parse({}).requiredWorkerTags).toEqual([]);
});
```

- [ ] **Step 2: Run the tests to verify they fail** — `pnpm --filter @office/shared test` → FAIL (unknown keys / no refinement).
- [ ] **Step 3: Implement** the schema changes above; the git refinement message is `git needs exactly one of repoPath or remote`.
- [ ] **Step 4: Prisma** — add the two columns; generate the migration with `pnpm --filter @office/db exec prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma --shadow-database-url "$SHADOW_URL" --script` (see `docs/development.md`), strip drift SQL touching `MemoryEntry`, apply with `migrate deploy` to `office` and `office_test`, confirm `MemoryEntry_search_idx` still exists. Extend `packages/db/test/schema.test.ts`: a created worker has `tags: []`, `canClone: false`.
- [ ] **Step 5: Run** `pnpm --filter @office/shared test && pnpm --filter @office/db test && pnpm typecheck` → PASS. Rebuild dists.
- [ ] **Step 6: Commit** `feat(shared,db): worker tags and canClone, run spec git.remote, requiredWorkerTags`

### Task 2: Git endpoint on the API

**Files:**
- Create: `apps/api/src/routes/git.ts`, `apps/api/git-hooks/pre-receive` (executable shell script), `apps/api/src/plugins/worker-bearer.ts`
- Modify: `apps/api/src/plugins/auth.ts` (exempt `/git/` prefix from the cookie hook), `apps/api/src/app.ts` (register), `apps/api/src/config.ts` (`gitHooksDir` resolved from the package dir, `GIT_HTTP_ENABLED` not needed)
- Test: `apps/api/test/git-endpoint.test.ts`

**Interfaces:**
- Consumes: `hashToken` (`apps/api/src/lib/tokens.ts`), `Worker.credentialHash`, `Project.repoPath`, `Project.defaultBranch`.
- Produces: `ALL /git/:projectId/*` → `git http-backend`. Auth: `Authorization: Bearer <credential>` matched against `Worker.credentialHash` with `status: { not: 'revoked' }`; otherwise 401 `{ error: 'worker_unauthorized' }`. Unknown project → 404. Env for the child: `GIT_PROJECT_ROOT=<OFFICE_DATA_DIR>/git-roots/<projectId>` (a directory containing one symlink `repo` → `repoPath`, created on demand), `PATH_INFO=/repo/<rest>`, `GIT_HTTP_EXPORT_ALL=1`, `REMOTE_USER=worker:<workerId>`, `OFFICE_DEFAULT_BRANCH=<defaultBranch>`, `GIT_CONFIG_COUNT=3`, `GIT_CONFIG_KEY_0=http.receivepack` `=true`, `GIT_CONFIG_KEY_1=core.hooksPath` `=<gitHooksDir>`, `GIT_CONFIG_KEY_2=receive.denyDeletes` `=true`, plus `REQUEST_METHOD`, `QUERY_STRING`, `CONTENT_TYPE`, `CONTENT_LENGTH`, `HTTP_CONTENT_ENCODING` when present. Request body streamed to stdin; CGI headers parsed from stdout into the reply (status from `Status:` header, default 200).
- Produces: `pre-receive` reads `<old> <new> <ref>` lines; exits 1 with a message on any of: `ref` not matching `^refs/heads/office/`, `new` all zeros (delete), `old` non-zero and `git merge-base --is-ancestor <old> <new>` false (non-fast-forward), `ref == refs/heads/$OFFICE_DEFAULT_BRANCH`. One bad line rejects the whole push.
- Content type: `app.addContentTypeParser(['application/x-git-upload-pack-request', 'application/x-git-receive-pack-request'], (req, payload, done) => done(null, payload))` so the raw stream reaches the handler.

- [ ] **Step 1: Write the failing tests** — the app listens on port 0 (`app.listen({ port: 0 })`); a temp repo with one commit on `main` is the project; a worker is enrolled through the real `hello` (use `connectFakeWorker` with `enrollToken`, read `credential` from `welcome`). Git client auth: `git -c http.extraHeader="Authorization: Bearer <cred>" clone http://127.0.0.1:<port>/git/<projectId> <dir>`.

```ts
it('clones with a valid worker credential', ...)            // clone succeeds; HEAD equals the repo's main
it('rejects a missing or wrong bearer with 401', ...)        // curl-equivalent via fetch(`/git/<id>/info/refs?service=git-upload-pack`) → 401
it('rejects a revoked worker with 401', ...)                 // DELETE /workers/:id then fetch → 401
it('returns 404 for an unknown project', ...)
it('accepts a fast-forward push to refs/heads/office/*', ...)  // commit in clone on branch office/t-abc123; push → ref exists in the repo
it('rejects a push to the default branch, a delete and a tag, atomically', ...)  // push office/ok + main in one command → neither ref updated; `push :office/t-abc123` → rejected; `push v1` tag → rejected
it('rejects a non-fast-forward of office/*', ...)              // amend + `push --force` → rejected, old sha intact
it('never passes a client path to the filesystem', ...)       // GET /git/<id>/../../etc/passwd → 404 or 400, and the repo-root symlink dir contains only `repo`
```

- [ ] **Step 2: Run** `pnpm --filter @office/api test -- git-endpoint` → FAIL (404 route).
- [ ] **Step 3: Implement** `worker-bearer.ts` (`async function authenticateWorkerBearer(app, request): Promise<{ workerId: string }>`), `routes/git.ts` (`gitRoutes(app)`), the hook script (`#!/bin/sh`, `set -eu`), config `gitHooksDir = join(packageDir, 'git-hooks')` where `packageDir` is derived from `import.meta.url` (works from `dist` and `src`: the hook dir is copied into `dist` by the build, or referenced from the package root — pick one and test both `pnpm dev` and `node dist/main.js`). Add `/git/` prefix exemption in `auth.ts` beside `PUBLIC_PATHS`.
- [ ] **Step 4: Run** the tests → PASS. `pnpm typecheck` clean.
- [ ] **Step 5: Commit** `feat(api): git endpoint for workers with bearer auth and an office/* fast-forward-only pre-receive hook`

### Task 3: Scheduler, gateway and resume pinning

**Files:**
- Modify: `apps/api/src/ws/worker-gateway.ts` (store `tags`, `canClone` on hello; `onlineWorkers()` exposes them), `apps/api/src/services/scheduler.ts` (`pickWorker`), `apps/api/src/services/run-service.ts` (`resumeRun` worker guard), `apps/api/src/services/approval-service.ts` (resume-before-send uses the pinned worker), `apps/api/src/routes/workers.ts` (PUBLIC adds `tags`, `canClone`, plus `online` and `activeRuns` from the gateway)
- Test: `apps/api/test/scheduler.test.ts`, `apps/api/test/worker-gateway.test.ts`, `apps/api/test/runs.test.ts`, `apps/api/test/fake-worker.ts` (options `tags`, `canClone`)

**Interfaces:**
- Produces: `pickWorker(project: { id, repoPath, settings }, opts: { needsRepoAccess: 'local' | 'any' }): OnlineWorker | undefined`. Eligible when free slot > 0, `requiredWorkerTags ⊆ worker.tags`, and either `allowedRoots` cover `repoPath` (local) or (`opts.needsRepoAccess === 'any'` and `worker.canClone`). Local workers are preferred when both qualify (stable sort: local first, then fewest active runs).
- Produces: `OnlineWorker` gains `tags: string[]`, `canClone: boolean`, `local(repoPath): boolean`.
- Produces: resumes (`resumeWaiting`, approval resume-before-send, any other `resumeRun` caller) choose `onlineWorkers().find(w => w.id === run.workerId && free slot)`; if absent the run stays parked (no error, debug log once per run per minute). On reply/approval timeout with the pinned worker still offline, the run is finished `failed` with error `pinned worker offline at resume` and the task retried per `maxAttempts` without `resumeSdkSessionId` (fresh session).
- Produces: `GET /workers` items: `{ id, name, status, capacity, allowedRoots, tags, canClone, lastHeartbeatAt, online: boolean, activeRuns: number }`.

- [ ] **Step 1: Write the failing tests**

```ts
// scheduler.test.ts
it('assigns a mission code run to a canClone worker when no local worker covers the repo', ...)   // fake worker allowedRoots: [] canClone: true → gets run.assign; spec.git.remote.path === `/git/${projectId}`; spec.git.repoPath undefined
it('never assigns a chat run to a canClone-only worker', ...)                                       // chat run stays queued/unassigned
it('prefers a local worker over a remote one', ...)
it('skips workers missing a required tag', ...)                                                     // project settings requiredWorkerTags: ['gpu']; worker tags [] → not assigned; worker tags ['gpu'] → assigned
it('resumes a waiting_reply run only on its original worker', ...)                                  // two workers; original offline → stays waiting_reply; original reconnects → resumed there with resumeSdkSessionId
it('fails a resume whose pinned worker is still offline at the timeout and retries fresh', ...)
// worker-gateway.test.ts
it('stores tags and canClone from hello and shows them on GET /workers with online and activeRuns', ...)
```

- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement**; mission runs get `git.remote` instead of `git.repoPath` when the chosen worker is not local (the spec is built per chosen worker: `missionRunFields(project, worker)`).
- [ ] **Step 4: Run** `pnpm --filter @office/api test` → PASS; typecheck clean.
- [ ] **Step 5: Commit** `feat(api): tag and clone aware worker selection, pinned resumes, worker status in GET /workers`

### Task 4: Worker config, hello and the on-disk result outbox

**Files:**
- Modify: `apps/worker/src/config.ts` (`tags`, `canClone`; `workspaceRoots` may be empty when `canClone`), `apps/worker/src/connection.ts` (hello fields; outbox), `apps/worker/src/main.ts` (load outbox on start)
- Create: `apps/worker/src/outbox.ts`
- Test: `apps/worker/test/config.test.ts`, `apps/worker/test/connection.test.ts`, `apps/worker/test/outbox.test.ts`

**Interfaces:**
- Produces: env `OFFICE_WORKER_TAGS` (comma-separated, validated with the Task 1 regex), `OFFICE_WORKER_CAN_CLONE` (`true`/`false`, default `false`). `OFFICE_WORKSPACE_ROOTS` may be empty only when `OFFICE_WORKER_CAN_CLONE=true`; otherwise the Phase 1 error stays.
- Produces: `class Outbox { constructor(dir: string); put(runId, msg: WorkerToApi): Promise<void>; delete(runId): Promise<void>; load(): Promise<Map<string, WorkerToApi>> }` at `<OFFICE_WORKER_HOME>/outbox/<runId>.json` (mode 0600). `connection.ts` writes a `run.result` to the outbox before trying to send, deletes it after a successful send on an open socket or after the API answers `error` naming that run (`No live lease for run <id>`), and lists outbox run ids in `activeRunIds` (already the case for the in-memory map).
- Produces: `hello` includes `tags` and `canClone`.

- [ ] **Step 1: Write the failing tests**

```ts
// config.test.ts
it('accepts empty OFFICE_WORKSPACE_ROOTS when OFFICE_WORKER_CAN_CLONE=true', ...)
it('rejects an invalid tag', ...)                                   // OFFICE_WORKER_TAGS='Bad Tag' → throws /OFFICE_WORKER_TAGS/
// outbox.test.ts
it('persists and reloads a result with mode 0600 and deletes it', ...)
// connection.test.ts
it('a result produced while disconnected survives a restart and is sent after the next welcome', ...)  // stop connection without socket; new WorkerConnection on the same home → fake API receives run.result
it('removes the outbox entry after the API rejects it for a lost lease', ...)                           // fake API replies error 'No live lease for run <id> on this worker' → file gone, no resend on next welcome
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** `pnpm --filter @office/worker test` → PASS; typecheck clean.
- [ ] **Step 5: Commit** `feat(worker): tags and canClone in hello; crash-safe result outbox`

### Task 5: Worker remote clone and push-based integration

**Files:**
- Create: `apps/worker/src/repos.ts`
- Modify: `apps/worker/src/executor.ts` (resolve the repository per spec), `apps/worker/src/git.ts` (`fastForward` for clones, `removeWorktree` branch deletion for clones)
- Test: `apps/worker/test/repos.test.ts`, `apps/worker/test/git.test.ts`, `apps/worker/test/executor.test.ts`

**Interfaces:**
- Consumes: `spec.git.remote.path`, `config.apiUrl` (`ws://` or `wss://` → `http://` / `https://`), the saved credential (`loadCredential(home)`).
- Produces: `ensureClone(opts: { apiUrl: string; credential: string; remotePath: string; reposDir: string; projectId: string; defaultBranch: string; missionBranch: string }): Promise<string>` → clone dir `<reposDir>/<projectId>`; first call `git clone --bare`? No: a normal clone with `--no-checkout` of `<http>/git/<projectId>` named remote `office`; every call then `git fetch office +refs/heads/<defaultBranch>:refs/remotes/office/<defaultBranch> +refs/heads/office/*:refs/heads/office/*` (mission and run branches mirrored). The credential is passed per command as `-c http.extraHeader=Authorization: Bearer <cred>` and never written to any file; `git` is spawned with `GIT_TERMINAL_PROMPT=0`.
- Produces: `ensureMissionBranch` on a clone creates `office/<mission>` from `office/<defaultBranch>` when absent locally, then pushes it (`git push office refs/heads/<mission>:refs/heads/<mission>`) and tolerates `already exists`/non-fast-forward by re-fetching (the API-side branch wins).
- Produces: `fastForward(repoPath, missionBranch, headCommit, remote?: RemoteAuth): Promise<IntegrationStatus>` — with `remote`, the CAS is `git push office <headCommit>:refs/heads/<mission> --force-with-lease=refs/heads/<mission>:<baseCommit>` where `baseCommit` is the worktree's recorded `baseCommit`; rejected → `needs_integration`. The run branch is pushed too (`refs/heads/<runBranch>`) before the mission push so a `needs_integration` run keeps its commits reachable on the API side.
- Produces: executor resolution: `spec.git.repoPath` present and under an allowed root → Phase 4 path. `spec.git.remote` present and `config.canClone` → `ensureClone(...)`; the clone dir is the repo for worktrees, checks and integration; `cwd` is the worktree. `spec.cwd` outside roots with no `remote` → `run.rejected` `cwd outside allowed roots` (unchanged). A spec with `remote` on a worker without `canClone` → `run.rejected` `worker cannot clone`.

- [ ] **Step 1: Write the failing tests** — the "API" is a temp non-bare repo served over `file://` (same push/fetch semantics; the HTTP transport is covered by Task 2 and Task 9).

```ts
// repos.test.ts
it('clones once and fetches on later calls; the credential header appears in no file under the clone', ...)   // grep -r "Bearer" <clone>/.git → nothing
it('creates and publishes the mission branch, and adopts the server copy when it already exists', ...)
// git.test.ts
it('remote fastForward pushes with force-with-lease and reports needs_integration when the server moved', ...)  // move server ref between fetch and push → needs_integration; server ref unchanged
it('a local update-ref CAS and a remote push CAS on the same branch admit exactly one winner', ...)             // run both against one repo: 1 fast_forwarded + 1 needs_integration, mission head is the winner's commit
// executor.test.ts
it('runs a remote spec in a worktree of the clone and pushes the run branch', ...)                            // result.git.integration === 'fast_forwarded'; server has refs/heads/<mission> at head and refs/heads/<runBranch>
it('rejects a remote spec when the worker cannot clone', ...)
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** Keep `git.ts` functions' local behaviour byte-identical for the `repoPath` path.
- [ ] **Step 4: Run** `pnpm --filter @office/worker test` → PASS; typecheck clean.
- [ ] **Step 5: Commit** `feat(worker): remote clone from the API git endpoint and push-based mission integration`

### Task 6: Lease recovery hardening on the API

**Files:**
- Modify: `apps/api/src/ws/worker-gateway.ts` (hello reattach: renew only leases this worker still owns; a run in `activeRunIds` that the DB says is `lost` or owned by another worker → `run.cancel` to the worker, already partly there as `cancelUnleased`), `apps/api/src/services/run-service.ts` (`expireLeases`: the lost run's `GitWorkspace` row is left as is — its worktree lives on the dead worker and that worker's sweep removes it; late `run.result` for a `lost` run → `error` exactly `No live lease for run <id> on this worker`)
- Test: `apps/api/test/worker-gateway.test.ts`, `apps/api/test/runs.test.ts`

**Interfaces:**
- Consumes: Phase 4 rejection rules (`docs/worker-protocol.md` "Rejection rules").
- Produces: `run.lease.lost` event payload gains `{ workerId, retried: boolean }`; `GET /runs/:id` shows `lostAt` (reuse `finishedAt`) and the retry run id when retried (`retriedByRunId` computed, no column).

- [ ] **Step 1: Write the failing tests**

```ts
it('a worker reconnecting with a run that was lost meanwhile gets run.cancel and its late result is rejected', ...)
it('a retry after a lost lease starts from the mission branch head, not the lost run worktree', ...)  // spec.git.missionBranch same; new runId; the lost run's GitWorkspace row untouched (removedAt null)
it('run.lease.lost carries workerId and retried', ...)
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** api tests → PASS.
- [ ] **Step 5: Commit** `fix(api): lease loss releases the workspace, cancels stale reattaches and records the retry`

### Task 7: Remote worker container

**Files:**
- Create: `infra/docker/worker.Dockerfile`, `infra/docker/worker-entrypoint.sh`
- Modify: `infra/compose.yaml` (service `worker-remote`, profile `remote`), `package.json` (`"worker:remote": "docker compose -f infra/compose.yaml --profile remote up -d --build worker-remote"`), `.env.example` (remote worker block), `.dockerignore`
- Test: manual verification recorded in the task report (the acceptance in Task 10 exercises it end to end)

**Interfaces:**
- Produces: image built from the repo root (`pnpm install --frozen-lockfile`, `pnpm build`, runtime stage with `node dist/main.js` of `apps/worker` and `git` installed). Env: `OFFICE_API_URL=ws://host.docker.internal:4000`, `OFFICE_WORKER_HOME=/office-worker` (named volume `office-worker-remote`), `OFFICE_WORKER_CAN_CLONE=true`, `OFFICE_WORKSPACE_ROOTS=` (empty), `OFFICE_RUNTIME=${OFFICE_REMOTE_RUNTIME:-fake}`, `OFFICE_WORKER_NAME=${OFFICE_REMOTE_WORKER_NAME:-remote-1}`, `OFFICE_WORKER_TAGS=remote`, `OFFICE_ENROLL_TOKEN=${OFFICE_REMOTE_ENROLL_TOKEN:-}`; `extra_hosts: ["host.docker.internal:host-gateway"]`. The container mounts nothing from the host filesystem. `API_HOST` must be `0.0.0.0` for the container to reach the API; document that in README (default stays `127.0.0.1`).
- Produces: `worker-entrypoint.sh` exits 2 with `OFFICE_ENROLL_TOKEN required on first start` when there is no `/office-worker/credentials.json` and no token.

- [ ] **Step 1: Build** `docker compose -f infra/compose.yaml --profile remote build worker-remote` → exit 0.
- [ ] **Step 2: Verify** with the API on `API_HOST=0.0.0.0`: create a worker (`POST /workers`), start the container with the token, `GET /workers` shows it `online`, `canClone: true`, `allowedRoots: []`, `tags: ['remote']`. Stop it; restart without the token → reconnects with the saved credential (volume).
- [ ] **Step 3: Commit** `feat(infra): remote worker container (compose profile remote)`

### Task 8: Workers page and Settings

**Files:**
- Modify: `apps/web/src/app/workers/page.tsx`, `apps/web/src/lib/queries.ts` (Worker type), `apps/web/src/components/settings-form.tsx` + `apps/web/src/lib/settings.ts` (`requiredWorkerTags` as a comma-separated field, validated with the tag regex), `apps/web/src/components/ui/*` as needed (a `TagList` chip row), `apps/web/e2e/pages.spec.ts`
- Test: `apps/web/src/lib/settings.test.ts` (extend), Playwright

**Interfaces:**
- Consumes: `GET /workers` fields from Task 3.
- Produces: Workers table shows status dot (`online`/`offline`/`pending`/`revoked`), mode `local` (roots listed) or `remote` (`canClone`), tags, `activeRuns/capacity`, last heartbeat relative time, Revoke button with confirm. No page-level `className`; pieces in `components/ui`.
- Produces: Settings → Execution: "Required worker tags" field; invalid tag → inline message `tags are lowercase letters, digits and dashes`.

- [ ] **Step 1: Write the failing tests** — `validateSettingsDraft` rejects `requiredWorkerTags: 'GPU'`, accepts `gpu, remote`; Playwright: `/workers` renders without console noise (already covered by static routes) and a fake worker row created through the API shows `remote` and its tag.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** `pnpm --filter @office/web test` and Playwright → PASS.
- [ ] **Step 5: Commit** `feat(web): workers page with mode, tags and activity; required worker tags setting`

### Task 9: Fake two-worker end-to-end test

**Files:**
- Create: `apps/worker/test/e2e-phase5.test.ts`
- Test: itself

**Interfaces:**
- Consumes: the Phase 4 harness pattern (`apps/worker/test/e2e-phase4.test.ts`: `buildApp`, `seed`, `RecordingAdapter`, `WorkerConnection`), `FakeAdapter` markers (`COMMIT` etc., `packages/runtime/src/fake`), the git endpoint (Task 2) over the app's real listening port.
- Produces: two `WorkerConnection`s against one API: `local` (`workspaceRoots: [repoRoot]`, `canClone: false`, home A) and `remote` (`workspaceRoots: []`, `canClone: true`, home B, `apiUrl` = the listening `ws://127.0.0.1:<port>`).

- [ ] **Step 1: Write the tests**

```ts
it('two parallel code tasks run on two workers and both integrate into the mission branch', ...)   // plan with tasks a, b (no dependency); assert runs' workerId differ; mission branch contains both commits; one of them may be needs_integration only if their bases raced — assert mission head is an ancestor-chain of both or one run is needs_integration with its branch present on the API repo
it('a remote worker never receives a repoPath', ...)                                                  // every spec recorded by the remote adapter has git.remote and no git.repoPath and cwd under home B
it('the remote worker check result and env template land like a local one', ...)                    // CheckResult rows for both; envFiles written in the clone's worktree, not in repoRoot
it('a chat run goes to the local worker only', ...)
it('a lost lease on the remote worker retries the task on the local worker from the mission head', ...)  // kill remote connection mid-run (stop() without sending result), advance leases (set leaseExpiresAt in DB), tick → lost + new run on local; late result from a re-created remote connection with the old runId → API error 'No live lease'
it('a waiting_reply run resumes only on its original worker', ...)                                   // remote asks awaitReply; reply arrives while remote is disconnected → stays waiting_reply; reconnect → resumed on remote
```

- [ ] **Step 2: Run** `pnpm --filter @office/worker test -- e2e-phase5` → PASS (fix defects found in Tasks 2–6 in this task's commits, each with its own test).
- [ ] **Step 3: Commit** `test(worker): phase 5 two-worker end-to-end with the fake runtime`

### Task 10: Docs, acceptance, progress

**Files:**
- Modify: `docs/worker-protocol.md` (hello `tags`/`canClone`, `git.remote`, git endpoint, outbox, reattach rules), `docs/security.md` (bearer auth, hook, revoked workers, remote workers never see the filesystem, credential handling in git commands), `docs/architecture.md`, `docs/development.md`, `README.md` (remote worker runbook: `API_HOST=0.0.0.0`, `pnpm worker:remote`, enrollment), `CLAUDE.md` (Phase 5 standing decisions), `docs/progress.md` (Phase 5 row, decisions, evidence, Outstanding), `.env.example`

**Interfaces:**
- Standing decisions to add: the API is the git endpoint for workers; only `refs/heads/office/*` fast-forwards are accepted there; remote workers clone into `<OFFICE_WORKER_HOME>/repos/<projectId>` and integrate by `--force-with-lease` push; runs without a worktree are local-only; resumes are pinned to the SDK session's worker; results are persisted in the worker outbox; tags are lowercase `[a-z0-9-]`; the remote worker container mounts no host path.

- [ ] **Step 1: Fake acceptance** — `pnpm --filter @office/worker test` (Task 9) passes; record counts in progress.
- [ ] **Step 2: Real acceptance (spec §17 Phase 5: two tasks on two machines coordinated safely)** — Machines: the host (local worker, `OFFICE_RUNTIME=claude`, roots covering the project) and the `worker-remote` container (Task 7, `OFFICE_REMOTE_RUNTIME=fake`, no host mounts). Project: the seeded `office-sandbox` (local sandbox repository; not Maratus). Mission request: `Add a CHANGELOG.md with a "Phase 5" entry and, separately, a scripts/hello.sh that prints "office"; the two tasks are independent and must run in parallel on two different workers.` The container runs the fake runtime, so its code task must carry the `FakeAdapter` commit marker (`packages/runtime/src/fake`) in its description: the mission request states the two task descriptions verbatim including the marker words; if the Chief's plan drops them, the owner stand-in edits the plan (`PUT /missions/:id/plan`) before approving. The host's real-Claude task needs no marker. Owner stand-in approves the plan via the API. Expected (record ids, worker ids, seqs, costs in "Phase 5 evidence"): (1) `GET /workers` shows both workers online, the container with `canClone: true`, `allowedRoots: []`; (2) the two code runs have different `workerId`s, one of them the container's; (3) the container run's spec in its events shows `git.remote` and no `repoPath` (the `agent.started` payload or the run row's spec), and `docker exec` shows the clone under `/office-worker/repos/<projectId>` with no host mount (`docker inspect` `Mounts` only the named volume); (4) both runs have `CheckResult` rows and the mission branch in the sandbox repo contains both commits (or one `needs_integration` with its run branch present, then integrated by a retry); (5) kill the container mid-run (`docker kill`) during a third task (`Add docs/PHASE5.md`): the lease expires, `run.lease.lost` appears, the task retries on the host worker and completes; restart the container: it reconnects with its saved credential and its stale run gets `run.cancel`/no effect; (6) the Chief's review closes the tasks from evidence; (7) after restarting the API and both workers, `GET /missions/:id` and the Workers page still show everything. Budget: stop (`POST /missions/:id/cancel`) if spend passes 5 USD. Record the sandbox repo's branches before and after. If an expectation fails, record it verbatim and leave Phase 5 `in progress` with the failing expectation named.
- [ ] **Step 3: Docs** as above; `docs/progress.md` Phase 5 → `done` only if every expectation held.
- [ ] **Step 4: Full verification** — `pnpm typecheck && pnpm test && pnpm build` and Playwright → exit 0.
- [ ] **Step 5: Commit** `docs: phase 5 hybrid workers, git endpoint, remote worker runbook; phase 5 evidence`
