# Architecture

This is a short overview of the design in `docs/superpowers/specs/2026-10-31-agent-office-design.md` (§5) and of what exists after Phase 3.

## Shape

```
                         owner (browser)
                               |
                 HTTP + cookie |  WebSocket /ws/ui (replay + live events)
                               v
  apps/web (Next.js, :3000) -------> apps/api (Fastify, :4000)  control plane
                                       | REST: auth, projects, agents, skills, tasks, runs, workers,
                                       |   conversations, messages, memory
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
6. **review → done.** Until Phase 4, a succeeded run moves the task to `review` and immediately to `done`; a failed or cancelled run moves it to `failed` or `cancelled`. From Phase 4 the Chief's review session decides `review → done` from platform-recorded evidence.

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
- `chat`: wakes an agent for mail from the owner in a `human` conversation. It resumes the conversation's SDK session, so the owner talks to one continuous session. Unlike `inbox`, it keeps the agent version's full tool surface and budget (spec §6.3). Approval gates for `chat` and `task` runs arrive in Phase 4.
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

Not built yet:

- Phase 3 leftovers: a `MemoryRevision` table (a revision is a new `MemoryEntry` row that supersedes the old one), streaming delivery into a live session, semantic memory search, the memory purge.
- Phase 4: `ProjectAgent` (deferred from Phase 2), `Mission`, `TaskDependency`, `GitWorkspace`, `Approval`, `Artifact`, check results, mission branches and per-run worktrees, the Chief's planning and review sessions, and the `waiting_approval` lifecycle (`waiting_reply` is built in Phase 3).
- Phase 5: remote workers, `WorkerCapability`, remote clone.
- Phase 6: `AuditLog`, `ProjectMember`, Agent Inspector, cost views, the interactive shell.
