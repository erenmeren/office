# Architecture

This is a short overview of the design in `docs/superpowers/specs/2026-10-31-agent-office-design.md` (§5) and of what exists after Phase 5.

## Shape

```
                         owner (browser)
                               |
                 HTTP + cookie |  WebSocket /ws/ui (replay + live events)
                               v
  apps/web (Next.js, :3000) -------> apps/api (Fastify, :4000)  control plane
                                       | REST: auth, projects, agents, skills, tasks, runs, workers,
                                       |   conversations, messages, memory, missions, approvals, audit
                                       | scheduler, leases, event store, event hub, office tools
                                       | Postgres (Prisma, :5433)   Redis (:6380, unused in Phase 1)
                                       ^
                 WebSocket /ws/worker  |  outbound from the worker; hello, heartbeat,
                 (worker credential)   |  run.accepted, run.event, run.result, tool.call, tool.result
                                       |
                              apps/worker  execution plane
                                       | RuntimeAdapter (packages/runtime)
                                       |   ClaudeAdapter -> Claude Agent SDK -> Claude Code
                                       |   FakeAdapter (OFFICE_RUNTIME=fake, tests)
                                       v
                       project repository under an allowed workspace root (local worker)
                       or a clone of it from the API's /git/<projectId> endpoint (remote worker)
```

Packages: `packages/shared` (Zod schemas, enums, event and protocol types, the task state machine), `packages/db` (Prisma schema, migrations, client, seed), `packages/runtime` (`RuntimeAdapter`, Claude and fake adapters, event normalization, secret redaction).

The control plane owns truth and never runs Claude. The worker never decides what to run; it executes leased runs and reports.

## Run lifecycle

1. **ready.** `POST /tasks` creates a task in `ready`.
2. **assign.** The scheduler (every 2 s) picks ready tasks by priority and age, finds an online worker with free capacity and repository access (see "Hybrid workers (Phase 5)" for local and remote placement), and in one transaction creates a `TaskRun` (`queued`, lease 60 s) and an `AgentSession` from the agent's current `AgentVersion`, increments the task's attempts and moves the task to `queued`. The session's `skillsSnapshot` records the version's pinned skills (`skillId`, `skillVersionId`, `name`, `version`, `checksum`, `mode`). It sends `run.assign` with the `RunSpec`, which carries the pinned skills' files and the version's subagents.
3. **accepted.** The worker checks that `cwd` resolves (symlinks included) under an allowed root, otherwise sends `run.rejected`. It sends `run.accepted`; the run, session and task move to `running`. It then materializes the pinned skills (see below) and starts the adapter; a skill that fails validation fails the run.
4. **events.** The adapter streams normalized events (`agent.started`, `agent.text`, `agent.tool.started`, `agent.tool.completed`, `agent.command.executed`, `agent.file.changed`, `agent.skill.invoked`, `agent.subagent.spawned`, `agent.subagent.completed`, `agent.completed`, and others). The worker redacts and sends each as `run.event`; the API redacts again, stores it as a `SessionEvent` keyed by `(sessionId, seq)` and publishes it to `run:<runId>` UI subscribers. Heartbeats renew the lease meanwhile.
5. **result.** The worker removes the run's materialized skills and sends `run.result`. Under a live lease the API records status, result text, error, cost and the SDK session id, writes a `UsageRecord`, and moves the task.
6. **review → done.** A succeeded run moves the task to `review`. A task without a mission then moves to `done` at once (Phase 1 behaviour); a mission task waits for the Chief's review run or the owner (see "Missions, git and approvals" below). A failed or cancelled run moves the task to `failed` or `cancelled`.

A run whose lease expires becomes `lost`, and the task goes back to `ready` while attempts remain. Status transitions go through one module (`packages/shared/src/task-state.ts`, applied by `apps/api/src/services/task-service.ts`). The wire protocol is in `docs/worker-protocol.md`.

## Skills and subagents

A `Skill` is a named directory of files (`SKILL.md` with `name` and `description` frontmatter, plus optional supporting files). Every change creates an immutable `SkillVersion` with a SHA-256 checksum of its files. Skills are authored in the UI (`approved` at once) or imported from a local directory, a git repository or the skills.sh marketplace (`pending_review` until the owner approves them). Only `approved` skills can be pinned. A marketplace install (`POST /skills/import {source:'market', id:'<owner>/<repo>/<skill>'}`) clones `https://github.com/<owner>/<repo>` and takes the directory whose `SKILL.md` is named `<skill>`; it is stored as a `git` skill. `POST /skills/:id/update` re-reads a git or local skill from its `sourceRef` and adds a version when the content changed; `DELETE /skills/:id` hard-deletes a skill unless an agent version pins it (`409 skill_pinned`). `GET /skills/market?q=` proxies the skills.sh search so the browser never calls outside localhost. The `model:` frontmatter of a skill is shown as a badge; the SDK reads it from the materialized `SKILL.md`.

An agent version pins skills (`AgentSkill`: skill, exact skill version, mode `eager` or `on_demand`) and defines native subagents (`AgentSubagent`: name, description, prompt, tools, model, turn limit and the pinned skills it may use). Both belong to the `AgentVersion` and change only by creating a new version.

Materialization: when building the `RunSpec`, the API includes each pinned skill's files and appends a skills section to the system prompt that names the eager skills to invoke first and lists the on-demand ones. The worker writes the files to `<OFFICE_WORKER_HOME>/runs/<runId>/.office/.claude/skills/<name>/` (mode 0600), outside the project repository, and passes `<runRoot>/.office` to the SDK as an additional directory (`additionalDirectories`) together with the `skills` filter of pinned names. The plugin layout was not needed (see "Runtime skill smoke" in `docs/progress.md`). Subagents are passed as the SDK's `agents` option, and the subagent tool is allowed under both its names, `Agent` and `Task`. The run root is removed after the run, and the worker sweeps leftover run roots when it starts.

The adapter reports `agent.skill.invoked` when the agent calls the `Skill` tool, and `agent.subagent.spawned` / `agent.subagent.completed` when it calls a subagent; the API records the latter as `SubagentRun` rows (`GET /runs/:id/subagents`).

## Messaging, memory and run kinds (Phase 3)

A `TaskRun` has a `kind`:

- `task`: the run of a task, as above.
- `inbox`: wakes an idle agent that has unread `question`, `help_request`, `handoff` or `escalation` mail from another agent. It has no task, gets only `Read`, `Glob` and `Grep` of the version's built-in tools, at most 8 turns, and is told to read its inbox and answer.
- `chat`: wakes an agent for mail from the owner in a `human` conversation. It resumes the conversation's SDK session, so the owner talks to one continuous session. Unlike `inbox`, it keeps the agent version's full tool surface and budget (spec §6.3). Like every run kind it carries the project's approval policy (see `docs/security.md`), but it works in the project repository itself, not in a worktree.
- `summary`: a run of the hidden `office-summarizer` agent (`haiku`) for one finished task run. It gets only the `submit_summary` tool: no built-in tools, skills or subagents.

Agents message and remember through 14 office tools (`packages/shared/src/office-tools.ts`): `send_message`, `reply_message`, `read_inbox`, `get_conversation`, `list_agents`, `request_help`, `handoff_task`, `escalate_to_chief`, `search_memory`, `read_memory`, `propose_memory`, `get_task_history`, `get_project_decisions`, and `submit_summary` (summary runs only). The Claude adapter serves them as an in-process SDK MCP server named `office`. A tool call goes from the SDK to the worker's `ToolBridge`, over the socket as `tool.call`, and the API executes it under the run's live lease. The answer comes back as `tool.result`. The API takes the agent and project from the calling session, never from the arguments.

Every message is stored before it is delivered. Mail newer than a running `task`, `chat` or `inbox` run is pushed into its live session (`run.message`, 2026-11-06). Otherwise delivery is at session boundaries: the agent sees new mail when it calls `read_inbox` or at its next run.

Waiting for a reply: `send_message`, `request_help` or `escalate_to_chief` with `awaitReply` ends the agent's turn. The adapter interrupts the SDK query and returns `suspended` with the SDK session id. The API moves the run, session and task to `waiting_reply`, releases the lease and frees the worker slot. When the reply arrives, or after `OFFICE_REPLY_TIMEOUT_MINUTES` (default 60), the scheduler resumes the same run on a worker: `waiting_reply → queued`, `resumeSdkSessionId` set, the reply (or a timeout note) as the prompt, and `startSeq` so the event `seq` continues. The API records `agent.resumed` itself.

Scheduler tick (every 2 s), in order:

1. Expire leases (`waiting_reply` runs hold none).
2. Assign `ready` tasks.
3. Resume `waiting_reply` runs whose reply arrived or whose wait timed out.
4. Wake idle agents with unread wake mail: one inbox or chat run per agent and project at a time, and at most two wake runs per unread wake delivery.
5. Summarize finished task runs: one summary run per run, claimed through `summarizedAt`. With no summarizer agent the runs wait.

The context pack: before every run, `buildContextPack` builds a short section for the system prompt, capped at `OFFICE_CONTEXT_PACK_MAX_CHARS` (default 12000). It holds the project overview, up to 10 verified memory entries ranked by full-text match against the task text (terms OR-ed), recent task summaries, the unread inbox and the agent's own lessons. The included entry ids, summary ids, inbox count and size are stored on `AgentSession.contextPack`, and the task page shows them.

Memory: agents propose entries (`proposed`). The owner verifies, rejects, edits or deletes them in Project Memory; an edit is a new row that supersedes the old one. Only verified entries reach the context pack and `search_memory`. The summarizer's `task_summary` is stored `verified` with its run and task as sources.

## Missions, git and approvals (Phase 4)

Run kinds added: `plan` and `review`, both run by the Chief (`opus`) with `Read`, `Glob`, `Grep` and read-only `Bash`, five read-only office tools (`search_memory`, `read_memory`, `get_task_history`, `get_project_decisions`, `list_agents`) and, for `review`, `get_task_evidence` and `review_task`. Both answer with structured output (`outputFormat` JSON schema).

Mission flow (`services/mission-service.ts`, `services/review-service.ts`):

1. **planning.** `POST /missions { projectId, request, title?, budgetUsd? }` creates a mission; the scheduler starts a `plan` run on a read-only worktree of the mission branch (the worker creates the branch `office/<slug>-<id6>` from the default branch head; the API fixes its name on the mission), so untracked secrets such as `.env.local` in the real repository are out of its reach. The prompt carries the request, the project's team (`ProjectAgent` rows; none means every active, non-system agent), settings and earlier plan errors.
2. **plan.** The plan JSON (`PlanSchema`) is validated: unique task keys, known `dependsOn` keys and no cycles, agents in the team, consultants in the team. An invalid plan (or no structured output) makes the mission `plan_failed` with the errors listed; a lost plan run is retried once. A valid plan is stored on `Mission.plan`, and the mission moves to `awaiting_approval` with a `plan` approval (or straight on with policy `auto`). The owner may edit (`PUT /missions/:id/plan`), replan (`POST /missions/:id/replan`), approve or reject.
3. **approved / running.** Approval creates one `Task` per plan task (`key`, `kind`, `requirements`, `acceptanceCriteria`, `requiredConsultations`, `budgetUsd`, `parallelGroup`) and `TaskDependency` rows; tasks without dependencies are `ready`, the rest `planned` until their dependencies are `done`. The mission branch already exists from the plan run's worktree.
4. **task runs.** A mission task run gets a worktree under `<OFFICE_WORKER_HOME>/worktrees/<runId>` on the run branch `<missionBranch>-runs/<taskSlug>-<run8>`, created from the mission branch head (so retries and dependents see integrated work), the project's `setupCommand`, the dummy env file, the `Office-Agent:` trailer hook and the project's approval policy. Analysis and review tasks get a read-only checkout. After a code run the worker collects the commits, runs `checkCommand` (`CheckResult`, the output stored as an `Artifact`), and fast-forwards the mission branch to the run head only when the check passed (or no check is configured). A failed check integrates nothing (`integration: none`); a run whose head is no longer a fast-forward of the mission branch (a parallel task integrated first) is `needs_integration`, and the Chief reopens the task (the retry starts from the new mission head) or the owner integrates by hand. A finished worktree is removed with its run branch when the mission branch contains that branch; a `needs_integration` branch is kept. The result text of a succeeded analysis or review run is stored as an artifact of that kind (`analysis.md`, `review.md`); a code run's result text is not.
5. **review.** When no task of a running mission is runnable, the scheduler starts the Chief's `review` run on a read-only worktree of the mission branch. It reads each task's evidence (`get_task_evidence`: runs, git summary, check results, artifacts, summaries, message counts) and decides each `review` task with `review_task` (`done`, `reopen` with a note, or `failed`; a task at `maxAttempts` cannot be reopened). `done` requires the evidence rule (code: at least one succeeded run's commits `fast_forwarded`, no committed run after the last fast-forwarded one left unintegrated, and a passed latest check, so an earlier failed-check or `needs_integration` attempt is superseded by its integrated retry; analysis: an artifact or memory entry; review: a `review` artifact) and every required consultation (a `question` from the task's agent to the consultant in the task's conversation, with a reply). Reopened or unblocked tasks send the mission back to `running`; a failed review run is retried, bounded. The owner overrides with `POST /tasks/:id/done|reopen|failed` (Mark done, Reopen and Failed in the task panel). Mission Control shows the mission summary under the plan card and, for a `done` or `failed` mission, links to the review run's events and its `mission-review.md`. A mission whose review tasks stay undecided stays `review`; the owner's decision on the last one settles it `done` (all tasks done) or `failed`.
6. **cancel.** `POST /missions/:id/cancel` is atomic and idempotent: it cancels the mission, its open tasks and their live runs. A task of a mission that is not `approved`, `running` or `review` never starts, and a run result that arrives after the cancel sends a failed task to `cancelled`, not back to `ready`.

Approvals (`services/approval-service.ts`): the worker's gate sends `approval.request` for a tool call the policy marks `ask`; the API stores an `Approval` (`pending`, `expiresAt`), moves the run and task to `waiting_approval` (lease and session stay live) and publishes `approval.changed`. The owner decides (`POST /approvals/:id/approve { scope: once|task }` or `/deny`); the API moves the run back to `running`, sends `approval.result` and records `deliveredAt`. Undelivered decisions are re-sent on the worker's `hello`; pending approvals expire after `approvalTimeoutMinutes` (deny). Plan and `budget_exceeded` approvals use the same table without a run.

Budgets (`services/budget-service.ts`): before assigning a mission task, the scheduler's gate checks, in order: the agent is in the project's team and active, the agent's `maxConcurrentSessions` (counted per project) and its own daily budget, the mission's spend against `Mission.budgetUsd`, the project's spend today against `dailyBudgetUsd` (raised by `dailyBudgetUsd` for each daily-budget `budget_exceeded` approval approved that day), and the project's `maxConcurrentRuns`. A daily-budget stop skips the task and opens at most one `budget_exceeded` approval per mission, reason and UTC day; approving it raises today's project limit. A mission-cap stop raises no approval: the plan card shows "Budget cap reached" and only the owner raises the cap (`PUT /missions/:id`). `GET /projects/:id/budget` reports today's spend and limit. Plan and review runs bypass the gate.

Scheduler tick additions (Phase 4): start plan runs for `planning` missions, expire pending approvals, gate mission tasks as above, and start review runs for stalled missions.

## Hybrid workers (Phase 5)

Workers are local or remote per project. A worker is local for a project when it runs on the API's machine (its `hello` `machineId` equals the API's) and its `allowedRoots` cover the repository path; any other worker with `canClone` is remote and works from its own clone. Matching paths alone do not make a worker local, since another host may share the path layout. Both compute the machine id the same way: `/etc/machine-id` trimmed, else a random id persisted (0600) at `<OFFICE_WORKER_HOME>/machine-id` on a worker and `<OFFICE_DATA_DIR>/machine-id` on the API. A worker that sends no `machineId` (older than Phase 5) is never local unless `OFFICE_TRUST_UNIDENTIFIED_WORKERS=true` (default false). Workers declare `tags`, `canClone` and `machineId` in `hello`.

- **Git endpoint.** The API serves every project repository at `/git/<projectId>` through `git http-backend` (`routes/git.ts`), behind the worker credential as a bearer token. Its `pre-receive` hook (`apps/api/git-hooks/pre-receive`) admits only fast-forwards of `refs/heads/office/*`; the default branch is never writable.
- **Placement.** The scheduler's `pickWorker` filters online workers by free slot and repository access, and for mission runs by the project's `requiredWorkerTags` (local-only runs ignore tags), then prefers local workers and the fewest active runs. Mission runs with a worktree (mission task runs, plan and review runs) may go to a remote worker; chat, inbox, summary and non-mission task runs are local-only, because they work in the repository itself.
- **Remote runs.** The run spec's `git` block carries `remote { path }` instead of `repoPath`. The worker (`apps/worker/src/repos.ts`) clones into `<OFFICE_WORKER_HOME>/repos/<projectId>`, fetches `office/*`, creates the run's worktree from the mission branch, runs the agent and the check, and integrates by pushing the run branch and then the mission branch with `--force-with-lease` against the run's base. A local worker's `update-ref` compare-and-swap and a remote worker's lease push on the same mission branch race safely: one wins, the other is `needs_integration`. A rejected lease push emits `agent.integration.failed { reason }` (git's stderr), and the run result carries it as `git.integrationReason`.
- **Resumes and leases.** A `waiting_reply` run resumes only on the worker that holds its SDK session; it stays parked while that worker is offline and fails at the reply timeout (`pinned worker offline at resume`), after which the task is retried fresh. A worker that disappears loses its runs at lease expiry (`run.lease.lost { workerId, retried }`), and the task is retried on any eligible worker from the mission branch head.
- **Results survive restarts.** The worker writes each result to `<OFFICE_WORKER_HOME>/outbox/<runId>.json` before sending it and re-sends it after a restart while the lease is live; once the run is `lost`, the API rejects it with `No live lease` and the worker drops it.
- **Remote container.** `infra/docker/worker.Dockerfile` and the Compose service `worker-remote` (profile `remote`) run a worker with no host mounts, its state in the named volume `office-worker-remote`, tag `remote`, `canClone`. `infra/compose.hostnet.yaml` optionally shares the host network.

The Workers page shows each worker's mode (local, remote or none), the first 8 characters of its machine id, tags, active runs against capacity and last heartbeat; Settings edits `requiredWorkerTags`.

## Observability and hardening (Phase 6)

Read models (`services/observability-service.ts`, `routes/observability.ts`) build every screen from stored records only: `SessionEvent`, `SubagentRun`, `UsageRecord`, `AuditLog`, `TaskRun` and `Approval`. No agent-written text decides a status.

- **Costs.** `GET /projects/:id/costs?days&groupBy=day|agent|mission|task` sums `UsageRecord.costUsd` per UTC day or per agent, mission or task. `GET /projects/:id/overview` returns the Dashboard KPIs (agents available, running sessions, pending tasks, approvals waiting, cost today against `dailyBudgetUsd`), the team rows (status, current work, worker, cost today) and the attention list (pending approvals, skills to review).
- **Activity.** `GET /projects/:id/activity` pages stored events of the project newest first (`SessionEvent (ts, id)` index); each row carries `key = sessionId:seq`. Every stored event is also published on the live-only UI topic `project:<projectId>`, and the Dashboard merges both by that key.
- **Sessions.** `GET /sessions?projectId&status=live|all` lists runs with agent, worker, task, cost and command and file counts; `GET /sessions/:runId` is the Agent Inspector's record (commands, files, subagents, skills snapshot, usage, `maxBudgetUsd`, pending approval); `GET /agents/:id/runs` is an agent's task-run history. The Inspector follows the run on the `run:` topic with replay.
- **Owner run cancel.** `POST /runs/:id/cancel` (`cancelRun` in `services/run-service.ts`) sends `run.cancel`, marks the run `cancelled` and writes `run.cancelled`. A mission task run's task returns to `ready` without consuming an attempt (`?task=true` cancels the task; a task of a cancelled or finished mission goes `cancelled`); a cancelled plan run cancels the mission; a cancelled review run leaves the mission in `review` with its `reviewRunId` (the owner decides through the overrides); a cancelled summary run resets the parent's `summarizedAt` so it is summarized again.
- **Audit.** `GET /audit` filters by `action`, `targetType`, `targetId`, `since` and pages with `before`; the Audit page renders it. Worker enrollment (`worker.enrolled`, in `ws/worker-gateway.ts`) and revocation (`worker.revoked`) are audited.
- **Result acknowledgement and integration under lease.** The API answers every applied `run.result` (and an idempotent resend of one) with `run.result.ack`, and the worker's outbox (`apps/worker/src/outbox.ts`) keeps the result until then. Before any fast-forward or push of a mission branch the worker asks `integration.check`; the API answers `ok` only under the worker's live lease (`docs/worker-protocol.md`). A corrupt outbox file is renamed to `.corrupt`.
- **Hardening.** `OFFICE_MACHINE_ID` overrides `/etc/machine-id` on both sides; the git endpoint kills `git http-backend` after `OFFICE_GIT_TIMEOUT_SECONDS` (600) and forwards `Git-Protocol` (v2); `TaskRun.maxBudgetUsd` is stored at creation; a waiting run that fails at resume writes a session event.
- **Web.** Dashboard `apps/web/src/app/page.tsx` (`components/dashboard-*.tsx`), Live Sessions `apps/web/src/app/sessions` (`session-list.tsx`, `session-detail.tsx`), Pixel Office `apps/web/src/app/office` (`office-floor.tsx`, `office-panel.tsx`, `lib/office.ts`), Agent Inspector `apps/web/src/app/sessions/[runId]` (`inspector-*.tsx`), Audit `apps/web/src/app/audit` (`audit-table.tsx`).

- **Desktop (2026-11-03).** `apps/desktop` is an Electron shell for Linux that runs the same API, worker and web server as child processes of Electron's Node, with a bundled Postgres (`@embedded-postgres/linux-x64`, port 5440, pgvector stubbed by `apps/desktop/pgstub`) and `apps/desktop/server/boot.mjs` for migrations, seed and worker enrollment; `apps/desktop/scripts/bundle.sh` builds the resources (`pnpm deploy` of `@office/desktop-server`, Next.js standalone). Ports 5440/4100/3100, state under `~/.local/share/office`. See README §17.

Not built in Phase 6 (the owner may request them): `ProjectMember`, session Pause, and messages addressed to a subagent; the interactive PTY shell arrived as the manual sessions of 2026-11-04 (below) and "Interrupt and send" on 2026-11-02. The project switcher was added on 2026-11-02: the header's `Select` (`apps/web/src/components/app-shell.tsx`) sets the project in `localStorage`, `useProject()` in `apps/web/src/lib/project.ts` reads it with a fallback to the first project, and every screen uses it; its last item opens `NewProjectForm`.

## Unified sessions (2026-11-04)

The owner's own Claude Code next to the agents' sessions, in four parts (`docs/superpowers/specs/2026-11-04-unified-sessions-design.md`):

- **Discovery (Phase 1).** `GET /claude-sessions` (`routes/claude-sessions.ts`) asks every connected worker with workspace roots through `WorkerGateway.requestSessions` (`sessions.request` / `sessions.response`, `apps/worker/src/sessions.ts`): SDK `listSessions({ includeProgrammatic: false })` filtered to the roots, merged with `claude agents --json --all` for `live` (kind, status, background state and short id), joined with projects by `repoPath` (local) or `/repos/<projectId>` (a remote clone), Office's own `AgentSession.sdkSessionId` removed. Transcripts (`/messages`, reduced turns, paged), `open` in a local terminal emulator, `rename` and `delete` (SDK) go to the session's worker. Nothing is stored.
- **Manual sessions (Phase 2).** `TerminalRegistry` (`services/terminal-service.ts`) owns Office terminals: `POST /terminals` picks the local (or asked) worker and sends `terminal.open`; the worker's `TerminalManager` (`apps/worker/src/terminals.ts`, `node-pty`, loaded on first use) runs `claude --session-id|--resume|--resume --fork-session|attach` in a folder under its roots with its environment minus Office's, streams `terminal.output` (base64), takes `terminal.input`/`terminal.resize`, ends with `terminal.exit`, and re-announces live terminals after every `welcome` (buffered output flushed then). The registry keeps 256 KB scrollback, hands the keyboard to the last UI socket that subscribed `terminal:<id>` on `/ws/ui` (`terminal.control`), publishes `terminal.changed` on `global`, writes `ManualSession` rows (loaded at API start; a running row not re-announced by its worker's first heartbeat is marked exited) and ends a disconnected worker's terminals. The web shows them with xterm.js (`components/office-terminal.tsx`: fit, search, clipboard keys, "Take control"), `terminal-detail.tsx` and the "Claude CLI" card on Live Sessions (`claude-session-list.tsx`, `claude-session-detail.tsx`).
- **Background sessions (Phase 3).** `claude --bg`, `stop`, `rm`, `logs` run on the worker (`runClaude`) through `sessions.request { kind: 'background' }`; `POST /claude-sessions/background`, `/background/:id/stop|rm|logs`; attach through a terminal with `attachId`.
- **Handoffs (Phase 4).** `apps/web/src/lib/mission-draft.ts` turns a transcript into a draft request for `ChiefComposer` (sessionStorage); a finished mission opens a manual session with its summary beside the terminal (`/sessions?terminal=&mission=`). Pixel Office draws the owner's room (`ownerRoom` in `lib/office.ts`, `OfficeOwnerPanel`); the Dashboard counts manual sessions in "Running sessions".

## Conductor, runtimes and routing (2026-11-08)

- **Conductor.** `services/conductor-service.ts`: `conductorHome` creates the hidden home project; `projectTab` and `openTab` make the Conductor's conversations, one per tab (`Conversation.aboutProjectId`, since 2026-11-12); `runConductorTool` answers its seven project tools (`create_project` since 2026-11-10: a greenfield project under `<OFFICE_DATA_DIR>/repos/<slug>`, slug from the name). `toolsForKind(kind, conductor)` gives a run in a system project the Conductor tool set; `specBase` sets `noBuiltinTools` and the Conductor prompt section. `routes/conductor.ts` serves `GET /conductor` (one tab, by `project` or `conversation`) and `POST /conductor/tabs`; the web page is `app/conductor/page.tsx`, the tab row `components/project-tabs.tsx`.
- **Runtimes.** `packages/runtime`: `RoutedAdapter` picks `ClaudeAdapter` or `CodexAdapter` by `spec.runtime`; `createAdapter` returns the adapter and the runtimes the worker announces. `codex/adapter.ts` spawns the CLI and maps its JSONL with `codex/normalize.ts`.
- **Router.** `services/router-service.ts` (`routeTask`, `agentDefault`); `Scheduler.assignReadyTasks` routes, picks a worker by runtime (`pickWorker` `runtime`), falls back, and passes the route to `createRunForTask`, which stores it on `TaskRun.routing`.

## Where each spec entity lives today

Built in Phase 1 (Prisma schema in `packages/db/prisma/schema.prisma`, logic in `apps/api/src`):

- `User`, `UserSession`: owner login (`routes/auth.ts`, `plugins/auth.ts`).
- `Project`: `routes/projects.ts`; repository path, default branch.
- `Agent`, `AgentVersion`: `routes/agents.ts`; every config change creates a new immutable version.
- `Worker`: `routes/workers.ts`, `ws/worker-gateway.ts`; enrollment, credential, allowed roots, heartbeat.
- `Task`: `routes/tasks.ts`, `services/task-service.ts`; title, description, priority, attempts, status.
- `TaskRun`: `services/run-service.ts`, `services/scheduler.ts`; lease, worker, agent version, status, cost.
- `AgentSession`: one per run; SDK session id, model, status.
- `SessionEvent`: `services/event-store.ts`, `ws/ui-gateway.ts`; persisted, replayable event log.
- `UsageRecord`: one per finished run; tokens and cost.

Built in Phase 2:

- `Skill`, `SkillVersion`: `routes/skills.ts`, `services/skill-service.ts`; library, import (local, git, market), marketplace search proxy, update from source, delete, versions, approve and reject.
- `AgentSkill`, `AgentSubagent`: `routes/agents.ts`, `services/agent-service.ts`; skill pins and subagents of an `AgentVersion`.
- `SubagentRun`: `services/subagent-service.ts`; one row per subagent call, recorded from `agent.subagent.*` events.
- `AgentSession.skillsSnapshot`: the pins a session ran with.
- Skill materialization: `apps/worker/src/skills.ts`. Agent Studio and the Skill Library: `apps/web/src/app/agents`, `apps/web/src/app/skills`.

Built in Phase 3:

- `Conversation`, `Message`, `MessageDelivery`: `services/message-service.ts`, `routes/conversations.ts`; conversations of kind `direct`, `task`, `group` and `human`, one delivery row per recipient, limits.
- `MemoryEntry`, `MemorySource`: `services/memory-service.ts`, `routes/memory.ts`; types `decision`, `convention`, `api_contract`, `known_issue`, `lesson`, `task_summary`; status `proposed`, `verified`, `rejected`; a supersede chain; sources of kind `event`, `message`, `commit`, `file`, `run`, `task`; a generated `tsvector` column for search and an unused `pgvector` column.
- `TaskRun` additions: `kind`, nullable `taskId`, `agentId`, `projectId`, `conversationId`, `waitingSince`, `waitingForMessageId`, `summaryOfRunId`, `summarizedAt`. `AgentSession.contextPack`. `Agent.isSystem` (the seeded `office-summarizer`).
- The office tools: `services/tool-service.ts` (execution), `ws/worker-gateway.ts` (`tool.call`), `packages/runtime` (`ToolBridge`, the in-process MCP server), `apps/worker/src/executor.ts` (relay).
- The context pack: `services/context-pack.ts`.
- Conversations and Project Memory pages: `apps/web/src/app/conversations`, `apps/web/src/app/memory`.

Built in Phase 4:

- `Mission`, `TaskDependency`: `routes/missions.ts`, `services/mission-service.ts`; plan, plan errors, plan and review run ids, branch, base commit, budget cap.
- `ProjectAgent`: `routes/projects.ts` (`GET`/`PUT /projects/:id/agents`); project settings (`ProjectSettingsSchema`) on `Project.settings` (`GET`/`PUT /projects/:id/settings`).
- `Approval`, `AuditLog`: `routes/approvals.ts`, `routes/audit.ts`, `services/approval-service.ts`, `services/audit-service.ts`.
- `GitWorkspace`, `CheckResult`, `Artifact`: `services/run-service.ts`, `services/artifact-store.ts`, `routes/artifacts.ts`; worktrees and integration in `apps/worker/src/git.ts` and `executor.ts`.
- `Task` additions: `key`, `kind`, `missionId`, `requirements`, `acceptanceCriteria`, `requiredConsultations`, `budgetUsd`, `parallelGroup`, `reviewNote`. `TaskRun` additions: `missionId`, `reviewOfMissionId`, `branch`, `baseCommit`, `headCommit`, `integration`, `worktreePath`, `structuredOutput`.
- The gate: `packages/runtime/src/gate.ts`; policy evaluation in `packages/shared/src/policy.ts`.
- Mission Control (plan graph, approvals, evidence) and Settings pages: `apps/web/src/app/mission-control`, `apps/web/src/app/settings`.

Built in Phase 5:

- `Worker` additions: `tags`, `canClone`, `machineId` (the spec's `WorkerCapability` is these two columns plus `allowedRoots`, not a table). `GET /workers` adds `tags`, `canClone`, `machineId`, `online` and `activeRuns`; `GET /runs/:id` adds `retriedByRunId`.
- The git endpoint: `routes/git.ts`, `plugins/worker-bearer.ts`, `apps/api/git-hooks/pre-receive`.
- Placement and pinned resumes: `services/scheduler.ts` (`pickWorker`, `resumeWaiting`), `services/run-service.ts` (remote specs, `run.lease.lost`).
- Remote clone and integration: `apps/worker/src/repos.ts`, `apps/worker/src/git.ts`; the result outbox: `apps/worker/src/outbox.ts`.
- The remote worker container: `infra/docker/worker.Dockerfile`, `infra/docker/worker-entrypoint.sh`, the `worker-remote` service in `infra/compose.yaml`, `infra/compose.hostnet.yaml`.
- Workers page and the Settings field for `requiredWorkerTags`: `apps/web/src/app/workers`, `apps/web/src/app/settings`.

Built in Phase 6:

- Read models: `services/observability-service.ts`, `routes/observability.ts`; the `project:` topic in `services/event-store.ts` and `ws/ui-gateway.ts`.
- `AuditLog` additions: `run.cancelled` (`services/run-service.ts` `cancelRun`, `routes/runs.ts`), `worker.enrolled` (`ws/worker-gateway.ts`), `worker.revoked` and `worker.deleted` (`routes/workers.ts`); filters in `routes/audit.ts`.
- `TaskRun.maxBudgetUsd` (migration `phase6_run_budget`) and the `SessionEvent (ts, id)` index.
- `run.result.ack`, `integration.check` and `integration.allowed`: `packages/shared/src/protocol.ts`, `ws/worker-gateway.ts`, `apps/worker/src/connection.ts`, `apps/worker/src/executor.ts`, `apps/worker/src/outbox.ts`.
- Dashboard, Live Sessions, Agent Inspector and Audit pages: `apps/web/src/app/page.tsx`, `apps/web/src/app/sessions`, `apps/web/src/app/audit`.

Not built yet:

- Phase 3 leftovers: a `MemoryRevision` table (a revision is a new `MemoryEntry` row that supersedes the old one), streaming delivery into a live session, semantic memory search, the memory purge.
- Phase 4 leftovers: push and PR creation (an approval request only). Worktree confinement was added on 2026-11-02 for every run with a worktree (file tools gated to the worktree and skills dir, Bash in the SDK sandbox); chat, inbox and non-mission task runs still work in the project repository, gated by the approval policy only.
- Phase 6 leftovers: `ProjectMember`, the interactive PTY shell, session Pause, messages to a subagent. "Interrupt and send" (`POST /runs/:id/interrupt`, `run.interrupt`) was added on 2026-11-02.
