# Phase 6: Observability and Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The owner can see what the team is doing and what it costs (Dashboard, Live Sessions, Agent Inspector, Audit), and the platform survives restarts without losing results or integrating work from lost runs.

**Architecture:** Observability reads existing records only: `SessionEvent`, `SubagentRun`, `UsageRecord`, `AuditLog`, `TaskRun`, `Approval`. The API adds read endpoints (`/projects/:id/costs`, `/projects/:id/activity`, `/sessions`, `/agents/:id/runs`, `/audit` filters) and a per-project live topic (`project:<id>`) on the existing UI WebSocket; the web app adds three screens from the owner's artboards (Dashboard rebuild, Live Sessions, Agent Inspector) plus an Audit page, all composed from `components/ui`. Hardening changes the worker protocol in two places: a `run.result.ack` so the outbox deletes only acknowledged results, and an `integration.check` round trip so a worker integrates only while its lease is live. Recovery is proven by an end-to-end test that restarts the API mid-run on a fixed port.

**Tech Stack:** Fastify 5, Prisma 7, Zod 4, `ws`, Next.js 16 + React 19 + Tailwind 4 (shadcn pattern), TanStack Query 5, Playwright, Vitest. No chart library: the 7-day cost chart is a CSS bar chart component.

**Spec:** `docs/superpowers/specs/2026-10-31-agent-office-design.md` §12 (screens), §13 (observability), §14 (security), §16 (testing), §17 Phase 6, §18 (jobs survive an API restart). Design: artifact "Claude Agent Office — Web UI" (slug `3a78301c-6c49-4bd7-9473-f02c9da01e2d`), artboards `project/Main.dc.html`, `project/LiveSessions.dc.html`, `project/AgentInspector.dc.html`; a structural summary is in the SDD workspace as `artboards.md` (copied from the controller's scratchpad). Standing decisions: `CLAUDE.md`. Hand-off: `docs/progress.md` Outstanding (Phase 4 and 5 items).

## Global Constraints

- Every chip, metric and status on the new screens is computed by the API from records, never from agent text (§12). Every success status links to the record behind it.
- Pages carry no styling; every visual piece is a component in `apps/web/src/components` or `components/ui` with Tailwind inside; tokens only in `apps/web/src/app/globals.css`.
- No secrets to the browser: events are already redacted; the audit `detail` column is rendered as text; worker credentials and tokens never appear in any response.
- `permissionMode: 'default'` unchanged; the runtime gate is untouched.
- Worker protocol additions are typed in `packages/shared/src/protocol.ts`, optional for backward compatibility where a message is new, and documented in `docs/worker-protocol.md`.
- Not built in this phase, by ruling (record in `docs/progress.md` "Phase 6 decisions"): the interactive PTY shell (spec §17 "if still wanted"; the owner has not asked; large security surface), `ProjectMember` (conflicts with the single-owner decision), "Pause" of a live session (the SDK has no pause), "Interrupt and send" delivery into a live session (streaming input remains the Phase 3 leftover; messages are delivered at the next run boundary and the UI says so).
- Commit messages end with exactly `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- `docs/progress.md` is updated at the end of the phase and whenever a decision changes.
- `apps/api` and `apps/worker` resolve `@office/shared|db|runtime` via `dist`: rebuild those packages before running api/worker tests after changing them.

## Review Focus

1. A worker whose lease expired but keeps running must not fast-forward or push the mission branch: `integration.check` denied → `needs_integration` with reason `lease lost`. Test in Task 3 and Task 4.
2. A `run.result` whose socket dies before the API acknowledges it must be re-sent after reconnect and stored once; a result acknowledged once must not be re-sent. Test in Task 3.
3. The API restarting while runs are live: workers reconnect, leases reattach, events after the restart continue the sequence, due summary runs and timeouts resume from the database, and the UI replay after reconnect shows no gap. Test in Task 4.
4. The project activity feed and the Live Sessions list must never show another project's events or runs (project id from the route, verified against the record). Test in Task 1.
5. Cost rollups must equal the sum of `UsageRecord.costUsd` for the same filter; "today" uses the same UTC-midnight boundary as the budget service. Test in Task 1.

---

### Task 1: Read models for observability

**Files:**
- Create: `apps/api/src/services/observability-service.ts`, `apps/api/src/routes/observability.ts`
- Modify: `apps/api/src/services/event-store.ts` (publish `project:<projectId>` beside `run:<runId>`), `apps/api/src/ws/ui-gateway.ts` (allow `project:` topics; no replay, live only), `apps/api/src/routes/audit.ts`, `apps/api/src/app.ts` (register)
- Test: `apps/api/test/observability.test.ts`, `apps/api/test/ui-gateway.test.ts`

**Interfaces:**
- Consumes: `UsageRecord`, `SessionEvent`, `AgentSession`, `SubagentRun`, `TaskRun`, `Approval`, `Skill` (`pending_review`), `utcMidnight` from `budget-service.ts`.
- Produces:
  - `GET /projects/:id/costs?days=7&groupBy=day|agent|mission|task` → `{ totalUsd, buckets: [{ key, label, costUsd, inputTokens, outputTokens }] }`; `day` keys are `YYYY-MM-DD` UTC, the last bucket is today (partial); `label` is the agent name / mission summary / task title.
  - `GET /projects/:id/overview` → `{ agentsAvailable, agentsTotal, runningSessions, maxConcurrentRuns, pendingTasks, awaitingApproval, costTodayUsd, dailyBudgetUsd, team: [{ agentId, name, role, status: 'running'|'needs_approval'|'idle', currentWork: string|null, workerName: string|null, costTodayUsd }], attention: [{ kind: 'approval'|'skill_review', id, title, detail, createdAt }] }`.
  - `GET /projects/:id/activity?limit=50&beforeSeqId=` → latest events across the project's runs, newest first: `[{ id, ts, type, agentId, agentName, runId, taskKey, detail }]` where `detail` is the same one-line summary the event log renders (reuse the summariser logic from `apps/web/src/components/event-log.tsx` by moving it into `packages/shared/src/event-summary.ts` `summarizeEvent(e): string`).
  - `GET /sessions?projectId=&status=live|all` → `[{ runId, sessionId, agentId, agentName, kind, status, taskId, taskKey, taskTitle, workerName, startedAt, costUsd, commands: number, files: number, subagents: [{ id, subagentType, description, status, startedAt, endedAt, commands, files }] }]` (`commands` = count of `agent.command.executed`, `files` = distinct paths in `agent.file.changed`; per subagent via `toolUseId` parentage when the event payload carries `parentToolUseId`, else 0).
  - `GET /sessions/:runId` → the same item plus `{ model, agentVersion, maxBudgetUsd, usage: { inputTokens, outputTokens }, commands: [{ seq, ts, command, exitCode?, durationMs? }], files: [{ path, adds?, dels?, bySubagent? }], skills: skillsSnapshot, approval: pending Approval|null }`.
  - `GET /agents/:id/runs?limit=20` → `[{ runId, taskKey, taskTitle, status, durationMs, costUsd, headCommit }]`.
  - `GET /audit?action=&targetType=&targetId=&since=&before=&limit=` (cursor `before` = createdAt ISO).
  - UI topic `project:<projectId>`: every stored event is also published there (`{ type: 'event', topic, event }`), live only.

- [ ] **Step 1: Write the failing tests**

```ts
it('costs by day sum to the usage records and end with today', ...)       // 3 UsageRecords over 2 days → totalUsd equals the sum; last bucket key is today's UTC date
it('costs by agent label buckets with agent names', ...)
it('overview counts running sessions, awaiting approval and cost today like the budget service', ...)  // costTodayUsd === spentToday()
it('activity returns only this project events, newest first, with a one-line detail', ...)  // two projects; cross-project event absent
it('sessions lists live runs with command and file counts and nested subagents', ...)
it('sessions/:runId exposes usage, skills snapshot, commands and files', ...)
it('agents/:id/runs lists past runs with cost and head commit', ...)
it('audit filters by action and since and pages with before', ...)
it('ui gateway streams project:<id> events live without replay', ...)
```

- [ ] **Step 2: Run** `pnpm --filter @office/api test -- observability ui-gateway` → FAIL.
- [ ] **Step 3: Implement**; all queries scoped by `projectId` from the route; `/sessions/:runId` 404s when the run's project is unknown.
- [ ] **Step 4: Run** api tests → PASS; typecheck clean; rebuild `@office/shared`.
- [ ] **Step 5: Commit** `feat(api): observability read models (costs, overview, activity, sessions, agent runs), project live topic, audit filters`

### Task 2: Owner run controls and audit coverage

**Files:**
- Modify: `apps/api/src/routes/runs.ts` (`POST /runs/:id/cancel`), `apps/api/src/services/run-service.ts` (reuse `cancelLiveRuns`), `apps/api/src/routes/workers.ts` + `apps/api/src/ws/worker-gateway.ts` (audit `worker.enrolled`, `worker.revoked`), `apps/api/src/services/audit-service.ts`
- Test: `apps/api/test/runs.test.ts`, `apps/api/test/worker-gateway.test.ts`

**Interfaces:**
- Produces: `POST /runs/:id/cancel` → 200 `{ id, status: 'cancelling'|'cancelled' }` for a live run (`queued|running|waiting_reply|waiting_approval`), 409 `run_not_live` otherwise; audit `run.cancelled { runId, by: userId }`; the task of a mission run goes `cancelled` only if the owner passes `?task=true`, else the task returns to `ready` without using an attempt (the run was stopped by the owner, not failed).
- Produces: audit rows `worker.enrolled { workerId, name, machineId? }` on a successful enrollment hello, `worker.revoked { workerId }` on `DELETE /workers/:id`.

- [ ] **Step 1: Tests** — `it('owner cancels a live run; the task is ready again and an audit row exists', ...)`, `it('cancel of a finished run is 409', ...)`, `it('enrollment and revocation are audited', ...)`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(api): owner run cancel; worker enrollment and revocation audited`

### Task 3: Protocol hardening — result ack and lease-checked integration

**Files:**
- Modify: `packages/shared/src/protocol.ts` (`ApiToWorker` += `run.result.ack { runId }`, `integration.allowed { runId, ok: boolean, reason?: string }`; `WorkerToApi` += `integration.check { runId }`), `apps/api/src/ws/worker-gateway.ts` (ack after `completeRun` succeeds or when the run is already final for this worker; answer `integration.check` from `findLeasedRun`), `apps/worker/src/connection.ts` + `apps/worker/src/outbox.ts` (delete on ack only, or on the `No live lease` error; resend unacked results on every welcome), `apps/worker/src/executor.ts` (before `fastForward`, `integration.check` with a 30 s timeout; `ok: false` or timeout → `needs_integration` with `integrationReason: 'lease lost'` / `'lease check timed out'`, emit `agent.integration.failed`)
- Test: `apps/api/test/worker-gateway.test.ts`, `apps/worker/test/connection.test.ts`, `apps/worker/test/executor.test.ts`, `docs/worker-protocol.md`

**Interfaces:**
- Produces: `run.result.ack` sent for every accepted `run.result` and for a duplicate `run.result` of a run that is already final and owned by this worker (so a resend after a lost ack is acknowledged, not rejected); a `run.result` without a live lease still gets `error` `No live lease for run <id> on this worker`.
- Produces: `integration.check` answered within the same socket; `ok` iff `findLeasedRun(runId, workerId)` is live.

- [ ] **Step 1: Tests**

```ts
// api
it('acks an accepted run.result and a resend of an already-final run owned by this worker', ...)
it('answers integration.check ok only while the lease is live', ...)
// worker connection
it('keeps the outbox entry until run.result.ack arrives and resends it after a reconnect', ...)
it('deletes the outbox entry on ack', ...)
// worker executor (fake API bridge)
it('refuses to fast-forward when integration.check says ok=false; result needs_integration with reason lease lost', ...)
it('refuses after a 30 s check timeout (use fake timers)', ...)
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** worker + api tests → PASS; rebuild `@office/shared`.
- [ ] **Step 5: Commit** `feat(protocol): run.result ack and lease-checked integration`

### Task 4: Recovery end-to-end tests

**Files:**
- Create: `apps/worker/test/e2e-phase6-recovery.test.ts`
- Test: itself (harness copied from `e2e-phase5.test.ts`; the API listens on a fixed free port chosen once with `net` so a rebuilt app reuses it)

**Interfaces:**
- Consumes: `buildApp`, `seed`, `WorkerConnection`, `FakeAdapter` `SLOW`/`COMMIT:`/`ASK:` markers, `scheduler.tick()`.

- [ ] **Step 1: Write the tests**

```ts
it('API restart mid-run: the worker reconnects, the lease reattaches, the run completes and events continue the sequence', ...)  // SLOW task; app.close() keeping prisma; buildApp again on the same port; worker reconnects within backoff; run succeeded; seqs strictly increasing with no duplicates
it('API restart with a due summary and an expired approval: both resume from the database on the first tick', ...)
it('a question sent before the restart wakes the recipient after it', ...)   // bus delivery across restarts (§16)
it('a result whose socket died before the ack is resent after reconnect and stored once', ...)  // terminate the worker socket right after run.result is sent (test hook: drop the ack); reconnect → ack → outbox empty; one TaskRun result, one usage record
it('a run whose lease was lost while it kept running does not fast-forward', ...)  // expire the lease in the DB; integration.check → ok=false; mission head unchanged; result needs_integration reason lease lost
```

- [ ] **Step 2: Run** `cd apps/worker && npx vitest run e2e-phase6` → PASS (defects found in Tasks 1–3 are fixed here with their own focused tests).
- [ ] **Step 3: Commit** `test(worker): phase 6 recovery end-to-end`

### Task 5: Small hardening from the Phase 4/5 Outstanding list

**Files:**
- Modify: `packages/runtime/src/machine-id.ts` + `apps/api/src/config.ts` + `apps/worker/src/config.ts` (`OFFICE_MACHINE_ID` override read first on both sides), `apps/api/src/services/run-service.ts` (`failWaitingRun` appends a `run.resume.failed { reason }` server event; `retriedByRunId` only `kind: 'task'`), `apps/worker/src/outbox.ts` (corrupt file renamed `<name>.corrupt` once), `apps/api/src/routes/git.ts` (forward `Git-Protocol` header as `GIT_PROTOCOL`; child timeout `OFFICE_GIT_TIMEOUT_SECONDS` default 600 → kill + 504), `packages/shared/src/enums.ts` (event type)
- Test: `packages/runtime/src/machine-id.test.ts`, `apps/api/test/runs.test.ts`, `apps/api/test/git-endpoint.test.ts`, `apps/worker/test/outbox.test.ts`

- [ ] **Step 1: Tests** one per item (override wins over `/etc/machine-id`; `run.resume.failed` present after the timeout path; corrupt file renamed; `GIT_PROTOCOL=version=2` reaches the child env (assert via a spawn hook or `--debug`-free check: `git -c protocol.version=2 ls-remote` succeeds and the API log records `v2`); a stalled child is killed after the timeout with 504).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `fix: machine id override, resume failure event, corrupt outbox rename, git protocol v2, http-backend timeout`

### Task 6: Dashboard from the Main artboard

**Files:**
- Modify: `apps/web/src/app/page.tsx` (compose only), `apps/web/src/lib/queries.ts` (`useOverview`, `useCosts`, `useActivity`, `useLiveSessions`), `apps/web/src/components/app-sidebar.tsx` (nav: add `Live Sessions` after Mission Control with a live count badge, `Audit` after Workers)
- Create: `apps/web/src/components/ui/kpi-card.tsx`, `ui/bar-chart.tsx` (CSS bars, labelled values, today highlighted as partial), `ui/activity-row.tsx`, `components/dashboard-team.tsx`, `components/dashboard-attention.tsx`, `components/dashboard-workers.tsx`, `components/dashboard-activity.tsx` (subscribes to `project:<id>` and prepends live rows), `components/dashboard-costs.tsx`
- Test: `apps/web/src/lib/*.test.ts` for any pure helper, Playwright `apps/web/e2e/pages.spec.ts`

**Interfaces:**
- Consumes: Task 1 endpoints. Artboard: KPI row (Active projects, Agents available n/total, Running sessions n/max, Pending tasks, Cost today $ with "% of $N daily budget"), Team table (Agent, Status chip Running/Needs approval/Idle, Current work with worker name, Cost), "Needs your attention" (approval rows with Approve/Deny reusing the approval actions; skill review rows linking to the Skill Library), Workers card (name, local/remote chip, state, slots used/max, heartbeat age), Recent activity (time, actor, event type, detail; live), "Cost, last 7 days" bar chart with the total and today's per-agent breakdown legend.
- Before writing the chart component, read the `dataviz` skill's palette rules and use the existing tokens.

- [ ] **Step 1: Playwright** — a stubbed-API dashboard test (`page.route` fixtures for overview/costs/activity) asserts the five KPI labels, a Team row, an attention row, and seven bars; the existing console-noise test keeps passing on `/`.
- [ ] **Step 2: Implement.** **Step 3: Run** web vitest + Playwright → PASS; no `className` in `page.tsx`.
- [ ] **Step 4: Commit** `feat(web): dashboard from the Main artboard (KPIs, team, attention, workers, live activity, 7-day cost chart)`

### Task 7: Live Sessions page

**Files:**
- Create: `apps/web/src/app/sessions/page.tsx`, `components/session-list.tsx` (nested subagents with the dashed avatar variant; filters All / Running / Needs you), `components/session-detail.tsx` (header metrics Commands / Files / Cost / Running; "Commands run by <name>" table with time, status, command, cwd, duration, exit code, live via `run:<id>`; "Files changed" table with status letter, file, dir, +/−, author; "Talk to <name>" composer posting to the agent's conversation with the copy `Delivered at the next run boundary`; Stop button → `POST /runs/:id/cancel` with confirm), `components/ui/agent-avatar.tsx` (add `subagent` dashed variant)
- Modify: `apps/web/src/lib/queries.ts`, `apps/web/src/lib/api.ts` if a helper is missing
- Test: Playwright with `page.route` fixtures (one agent with one running subagent; selecting the subagent shows its commands only; Stop calls the cancel route)

**Interfaces:**
- Consumes: `GET /sessions`, `GET /sessions/:runId`, `POST /runs/:id/cancel`, conversations API (Phase 3) for the composer, `uiSocket().subscribe('run:<id>')`.
- Not built (ruling, show nothing): Pause, "Interrupt and send", messages addressed to a subagent (the recipient tabs list only agents; the note explains subagents are reached through their parent).

- [ ] **Step 1: Playwright tests.** **Step 2: Implement.** **Step 3: Run** → PASS; no page-level styling.
- [ ] **Step 4: Commit** `feat(web): Live Sessions page`

### Task 8: Agent Inspector page

**Files:**
- Create: `apps/web/src/app/sessions/[runId]/page.tsx`, `components/inspector-header.tsx` (avatar, name, status chip, role, model, `config v<n>`, worker, session id; metrics Tokens "<in> in · <out> out", Session cost "$x cap $y", Running for; actions Message → conversation, Stop session → cancel), `components/inspector-tabs.tsx` (Activity: `RunEvents` with a "Following live · seq N" status line and a Pause-following toggle; Commands; Files; Subagents; History), `components/inspector-rail.tsx` (Current task card linking to Mission Control; "Waiting for you" reusing `ApprovalCard` actions; Subagents list "Depth 1 of 1"; "Skills in this session" from `skillsSnapshot` with Eager / On demand chips), `components/previous-tasks-table.tsx` (Task, Title, Result, Time, Cost, Commit from `GET /agents/:id/runs`)
- Modify: `apps/web/src/components/session-list.tsx` (row link to the inspector), `apps/web/src/app/agents/[id]/page.tsx` (link "Inspect live session" when one exists)
- Test: Playwright with fixtures (header metrics, a `agent.waiting_approval` row, the approval rail card, a skills chip, a previous-tasks row); the interactive shell is omitted (ruling).

- [ ] **Step 1: Playwright tests.** **Step 2: Implement.** **Step 3: Run** → PASS.
- [ ] **Step 4: Commit** `feat(web): Agent Inspector page`

### Task 9: Audit page

**Files:**
- Create: `apps/web/src/app/audit/page.tsx`, `components/audit-table.tsx` (columns Time, Action, Target, Detail as text; filters: action select from the distinct actions in the loaded page, target type, since date; "Load older" with the `before` cursor)
- Modify: `apps/web/src/lib/queries.ts` (`useAudit`)
- Test: Playwright (renders rows from a fixture; filter narrows; load older appends)

- [ ] **Step 1: Playwright test.** **Step 2: Implement.** **Step 3: Run** → PASS.
- [ ] **Step 4: Commit** `feat(web): Audit page`

### Task 10: Docs, acceptance, progress

**Files:**
- Modify: `docs/progress.md` (row 6, "Phase 6 decisions", "Phase 6 evidence", Outstanding), `docs/architecture.md` (observability section, Phase 6 "where entities live"), `docs/worker-protocol.md` (ack, integration check, `project:` topic), `docs/security.md` (audit coverage, run cancel, git timeout/protocol), `docs/development.md` (recovery e2e), `README.md` (the new screens, audit, `OFFICE_MACHINE_ID`, `OFFICE_GIT_TIMEOUT_SECONDS`), `CLAUDE.md` (Phase 6 standing decisions), `.env.example`

**Interfaces:**
- Standing decisions to add: observability reads records only; `project:<id>` live topic; `run.result.ack` and outbox semantics; integration only under a live lease; owner run cancel returns the task to `ready` without an attempt; PTY shell, `ProjectMember`, Pause and interrupt delivery not built (owner may request); `OFFICE_MACHINE_ID`; `OFFICE_GIT_TIMEOUT_SECONDS` 600.

- [ ] **Step 1: Fake acceptance** — `pnpm --filter @office/worker test` (Task 4 recovery e2e) passes; record counts.
- [ ] **Step 2: Real acceptance (spec §17 Phase 6: Inspector, cost views, audit, recovery)** — with the host worker on real Claude (`OFFICE_RUNTIME=claude`) and the API on `0.0.0.0:4000`: (1) start a chat run to `developer` on `office-sandbox` asking it to run `ls` and `git status` and report; while it runs, Live Sessions lists it `Running` with its commands streaming and the Inspector shows `Following live`; after it ends the Dashboard's Cost today and the Team row's cost include its `costUsd` (compare with `GET /projects/:id/costs`); (2) start a second chat run asking for a `SLOW`-like long task (count to 30 with one `sleep 1` per step) and Stop it from the Inspector: `POST /runs/:id/cancel` → run `cancelled`, audit row `run.cancelled`, Audit page shows it; (3) restart the API by pid while a third chat run is live: the worker reconnects, the run completes, its events are gap-free (`seq` strictly increasing), and the Inspector's feed shows the replayed tail after reconnect; (4) `GET /audit` shows `worker.enrolled` for a fresh enrollment of a throwaway worker and `worker.revoked` after revoking it. Record run ids, seqs, costs, audit ids in "Phase 6 evidence". Budget stop 2 USD. If an expectation fails, record it verbatim and leave Phase 6 `in progress` naming it.
- [ ] **Step 3: Docs** as above; `docs/progress.md` Phase 6 → `done` only if every expectation held.
- [ ] **Step 4: Full verification** — `pnpm typecheck && pnpm test && pnpm build` and Playwright → exit 0.
- [ ] **Step 5: Commit** `docs: phase 6 observability and hardening; phase 6 evidence`
