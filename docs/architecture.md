# Architecture

This is a short overview of the design in `docs/superpowers/specs/2026-10-31-agent-office-design.md` (§5) and of what exists after Phase 4.

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
                       project repository under an allowed workspace root
```

Packages: `packages/shared` (Zod schemas, enums, event and protocol types, the task state machine), `packages/db` (Prisma schema, migrations, client, seed), `packages/runtime` (`RuntimeAdapter`, Claude and fake adapters, event normalization, secret redaction).

The control plane owns truth and never runs Claude. The worker never decides what to run; it executes leased runs and reports.

## Run lifecycle

1. **ready.** `POST /tasks` creates a task in `ready`.
2. **assign.** The scheduler (every 2 s) picks ready tasks by priority and age, finds an online worker with free capacity whose allowed roots contain the project's repository path, and in one transaction creates a `TaskRun` (`queued`, lease 60 s) and an `AgentSession` from the agent's current `AgentVersion`, increments the task's attempts and moves the task to `queued`. The session's `skillsSnapshot` records the version's pinned skills (`skillId`, `skillVersionId`, `name`, `version`, `checksum`, `mode`). It sends `run.assign` with the `RunSpec`, which carries the pinned skills' files and the version's subagents.
3. **accepted.** The worker checks that `cwd` resolves (symlinks included) under an allowed root, otherwise sends `run.rejected`. It sends `run.accepted`; the run, session and task move to `running`. It then materializes the pinned skills (see below) and starts the adapter; a skill that fails validation fails the run.
4. **events.** The adapter streams normalized events (`agent.started`, `agent.text`, `agent.tool.started`, `agent.tool.completed`, `agent.command.executed`, `agent.file.changed`, `agent.skill.invoked`, `agent.subagent.spawned`, `agent.subagent.completed`, `agent.completed`, and others). The worker redacts and sends each as `run.event`; the API redacts again, stores it as a `SessionEvent` keyed by `(sessionId, seq)` and publishes it to `run:<runId>` UI subscribers. Heartbeats renew the lease meanwhile.
5. **result.** The worker removes the run's materialized skills and sends `run.result`. Under a live lease the API records status, result text, error, cost and the SDK session id, writes a `UsageRecord`, and moves the task.
6. **review → done.** A succeeded run moves the task to `review`. A task without a mission then moves to `done` at once (Phase 1 behaviour); a mission task waits for the Chief's review run or the owner (see "Missions, git and approvals" below). A failed or cancelled run moves the task to `failed` or `cancelled`.

A run whose lease expires becomes `lost`, and the task goes back to `ready` while attempts remain. Status transitions go through one module (`packages/shared/src/task-state.ts`, applied by `apps/api/src/services/task-service.ts`). The wire protocol is in `docs/worker-protocol.md`.

## Skills and subagents

A `Skill` is a named directory of files (`SKILL.md` with `name` and `description` frontmatter, plus optional supporting files). Every change creates an immutable `SkillVersion` with a SHA-256 checksum of its files. Skills are authored in the UI (`approved` at once) or imported from a local directory or a git repository (`pending_review` until the owner approves them). Only `approved` skills can be pinned.

An agent version pins skills (`AgentSkill`: skill, exact skill version, mode `eager` or `on_demand`) and defines native subagents (`AgentSubagent`: name, description, prompt, tools, model, turn limit and the pinned skills it may use). Both belong to the `AgentVersion` and change only by creating a new version.

Materialization: when building the `RunSpec`, the API includes each pinned skill's files and appends a skills section to the system prompt that names the eager skills to invoke first and lists the on-demand ones. The worker writes the files to `<OFFICE_WORKER_HOME>/runs/<runId>/.office/.claude/skills/<name>/` (mode 0600), outside the project repository, and passes `<runRoot>/.office` to the SDK as an additional directory (`additionalDirectories`) together with the `skills` filter of pinned names. The plugin layout was not needed (see "Runtime skill smoke" in `docs/progress.md`). Subagents are passed as the SDK's `agents` option, and the subagent tool is allowed under both its names, `Agent` and `Task`. The run root is removed after the run, and the worker sweeps leftover run roots when it starts.

The adapter reports `agent.skill.invoked` when the agent calls the `Skill` tool, and `agent.subagent.spawned` / `agent.subagent.completed` when it calls a subagent; the API records the latter as `SubagentRun` rows (`GET /runs/:id/subagents`).

## Messaging, memory and run kinds (Phase 3)

A `TaskRun` has a `kind`:

- `task`: the run of a task, as above.
- `inbox`: wakes an idle agent that has unread `question`, `help_request`, `handoff` or `escalation` mail from another agent. It has no task, gets only `Read`, `Glob` and `Grep` of the version's built-in tools, at most 8 turns and 0.25 USD, and is told to read its inbox and answer.
- `chat`: wakes an agent for mail from the owner in a `human` conversation. It resumes the conversation's SDK session, so the owner talks to one continuous session. Unlike `inbox`, it keeps the agent version's full tool surface and budget (spec §6.3). Like every run kind it carries the project's approval policy (see `docs/security.md`), but it works in the project repository itself, not in a worktree.
- `summary`: a run of the hidden `office-summarizer` agent (`haiku`) for one finished task run. It gets only the `submit_summary` tool: no built-in tools, skills or subagents.

Agents message and remember through 14 office tools (`packages/shared/src/office-tools.ts`): `send_message`, `reply_message`, `read_inbox`, `get_conversation`, `list_agents`, `request_help`, `handoff_task`, `escalate_to_chief`, `search_memory`, `read_memory`, `propose_memory`, `get_task_history`, `get_project_decisions`, and `submit_summary` (summary runs only). The Claude adapter serves them as an in-process SDK MCP server named `office`. A tool call goes from the SDK to the worker's `ToolBridge`, over the socket as `tool.call`, and the API executes it under the run's live lease. The answer comes back as `tool.result`. The API takes the agent and project from the calling session, never from the arguments.

Every message is stored before it is delivered. Delivery into a live session is at session boundaries: the agent sees new mail when it calls `read_inbox` or at its next run.

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

Budgets (`services/budget-service.ts`): before assigning a mission task, the scheduler's gate checks, in order: the agent is in the project's team and active, the agent's `maxConcurrentSessions` and its own daily budget, the mission's spend against `Mission.budgetUsd`, the project's spend today against `dailyBudgetUsd` (raised by `dailyBudgetUsd` for each daily-budget `budget_exceeded` approval approved that day), and the project's `maxConcurrentRuns`. A daily-budget stop skips the task and opens at most one `budget_exceeded` approval per mission, reason and UTC day; approving it raises today's project limit. A mission-cap stop raises no approval: the plan card shows "Budget cap reached" and only the owner raises the cap (`PUT /missions/:id`). `GET /projects/:id/budget` reports today's spend and limit. Plan and review runs bypass the gate.

Scheduler tick additions (Phase 4): start plan runs for `planning` missions, expire pending approvals, gate mission tasks as above, and start review runs for stalled missions.

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

- `Skill`, `SkillVersion`: `routes/skills.ts`, `services/skill-service.ts`; library, import (local, git), versions, approve and reject.
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

Not built yet:

- Phase 3 leftovers: a `MemoryRevision` table (a revision is a new `MemoryEntry` row that supersedes the old one), streaming delivery into a live session, semantic memory search, the memory purge.
- Phase 4 leftovers: the greenfield path (a mission on a project without a repository), push and PR creation (an approval request only), worktree confinement for chat, inbox and non-mission task runs (they are gated by the approval policy but work in the project repository).
- Phase 5: remote workers, `WorkerCapability`, remote clone.
- Phase 6: an audit UI, `ProjectMember`, Agent Inspector, cost views, the interactive shell.
