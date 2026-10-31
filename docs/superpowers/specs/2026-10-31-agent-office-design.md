# Claude Agent Office — Design

Date: 2026-10-31
Status: approved by owner on 2026-10-31 (see §20)
Repository: `/home/meren/projects/office` (this repo, English throughout)

## 1. Intent

Agent Office turns Claude Code sessions into a persistent AI software team. An **agent** is a durable employee: fixed identity, fixed skill set, its own memory, a history of past work. A **session** is a temporary Claude Code run that an agent performs. A **Chief** agent plans and coordinates; the backend enforces everything that matters (dependencies, budgets, concurrency, approvals, task state).

The product is not a chatbot that imitates Claude Code. It manages real Claude Code sessions, connects them to each other over a durable message bus, and makes their work and knowledge survive after the sessions end.

The 3D virtual office is explicitly out of scope. The event model must make it possible later without backend rewrites.

## 2. Why now, and what success looks like

The owner wants to point the platform at a real codebase first, not a toy. The first target is **Maratus Admin** (`/home/meren/projects/maratus-admin`: Next.js 16, Drizzle ORM on Neon, vitest). The first mission is a reliability improvement to the till-to-device mapping and QR trigger flow, with no new system built, no merge, no deploy.

The owner will say "it works" when three things are observable:

1. **Agents really talk.** The Developer sends the Architect a concrete question ("can the same till number be assigned to two devices? I cannot find validation in the code"). The Architect inspects the code and replies with the file and the rule. The Developer writes its test from that answer. Both halves are visible in two separate real Claude Code session records.
2. **Real work is produced.** The git diff, the added tests, and the test results exist. QA ran them independently. The Chief can explain what changed and why. No agent reports "done" without verifiable artifacts.
3. **The system remembers.** All agent sessions are closed and restarted. The owner asks the Developer "what did we do last time on Maratus till mapping?" and it answers with the task history, the Architect conversation, the commit, and the recorded decisions, each with a source reference. It does this by searching stored records, not by model recall.

A secondary success path: start a **greenfield** project by talking to the Chief. The Chief clarifies, plans, gets approval, and organizes the team. Same plan and approval flow as the Maratus case; the "inspect repository" step becomes "initialize repository".

## 3. Goals, non-goals, anti-goals

### Goals

- Persistent agents with versioned configuration, permanent skill assignment, and isolated per-project memory.
- Real execution through the official Claude Agent SDK. Mock adapter exists for tests only and is clearly separated.
- Direct agent-to-agent messaging over a persisted bus, with loop limits.
- Curated long-term memory separate from raw session history, with provenance.
- Chief agent that plans a task DAG; backend scheduler that decides what actually runs.
- Human approval gates the Chief cannot bypass.
- Live observability: agent state, tool activity, events, cost, with reconnection replay.
- Web UI covering all of the above, dark theme, functional over pretty.
- Runnable after every phase. Progress recorded in `CLAUDE.md` and `docs/` so later sessions can resume.

### Non-goals (for this build)

- 3D office, animations, characters.
- Additional AI providers.
- Multi-tenant SaaS, billing, public sign-up.
- Interactive PTY shell in the browser (deferred; see §13).
- Semantic (vector) search in the first pass; keyword search ships first, pgvector is kept open (see §9).
- Remote workers before the three success criteria pass on a single local worker.

### Anti-goals (would make this a failure even if it "works")

- An agent that reports success without a diff, test output, or other evidence behind it.
- Memory that is just a dump of transcripts, or a chat UI that only pretends an agent "remembers".
- Backend correctness that depends on the LLM obeying its prompt.
- Permission-bypass execution modes as the default.
- A platform-level specialist agent modeled as the same thing as a native Claude subagent.
- Skill lists that have to be re-stated in every prompt.

## 4. Verified constraints (checked on 2026-10-31)

Machine:

- Claude Code CLI 2.1.316, authenticated by `claude login`, subscription `max`. No `ANTHROPIC_API_KEY`.
- Node 26.12, npm, Docker 29 with Compose v5, git 2.56. pnpm 12 installed during brainstorming.
- Another project's Postgres container holds `5432/tcp` inside Docker without a host mapping; our Compose will publish Postgres on host port 5433 to avoid any collision.

Maratus Admin (first target):

- Uses npm (`package-lock.json`). `npm test` runs vitest over `lib/**/*.test.ts`; 65 files, 661 tests, pass in about 3.5 s. The tests are pure unit tests. They do not open a database.
- `vitest.config.ts` loads `.env.local` only so that env-validated modules can be imported. `.env.local` is not in git and its `DATABASE_URL` points at a Neon host; it is treated as production and is never copied into a worktree.
- Consequence: a worktree needs `npm ci` and a stand-in env file with syntactically valid dummy values to run the tests. See §8.6.

Agent SDK (`@anthropic-ai/claude-agent-sdk` 0.3.316, TypeScript), confirmed from current docs and one live probe:

- **Auth:** a one-shot `query()` with the current login succeeded (`apiKeySource: none`, model `claude-haiku-5-5`). The docs describe `ANTHROPIC_API_KEY`; subscription OAuth through the SDK is undocumented and Anthropic's policy forbids offering claude.ai login in third-party products. This is a personal tool on the owner's machine. Decision: the runtime adapter never handles credentials. The worker process inherits whatever auth its environment has (CLI login today, `ANTHROPIC_API_KEY` later). Switching is an environment change only. The worker must strip inherited `CLAUDE*` variables from the child environment so it does not look like a nested session, then set its own `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS` and `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` from the agent version.
- **Skills:** loaded from the filesystem only: `cwd/.claude/skills/`, `~/.claude/skills/`, and `.claude/skills/` under each `additionalDirectories` entry. `skills: string[]` whitelists by name per query. Loading is on demand (metadata at start, body when invoked). No programmatic registration API.
- **Subagents:** `agents: Record<name, AgentDefinition>` with `description`, `prompt`, `tools`, `model`, `skills`, `maxTurns`, `effort`. Spawn appears as an `Agent` tool use; inner messages carry `parent_tool_use_id` and `agent_id`; lifecycle messages `SDKTaskStartedMessage`, `SDKTaskProgressMessage`, `SDKTaskNotificationMessage`. Concurrency and depth via env `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`, `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH`.
- **In-process tools:** `createSdkMcpServer` + `tool()`, passed via `mcpServers`, permitted as `mcp__<server>__<tool>`.
- **Sessions:** `resume`, `forkSession`, streaming-input mode (`AsyncIterable<SDKUserMessage>`) for follow-up messages into a live query, `query.interrupt()`.
- **Permissions:** `permissionMode` (`default` for us), `allowedTools`, `disallowedTools`, `canUseTool(toolName, input, ctx)` returning allow/deny, `hooks` for PreToolUse, PostToolUse, SubagentStart, SubagentStop, Stop, SessionStart and more.
- **Limits and usage:** `maxTurns`, `maxBudgetUsd` (client-side estimate, soft), result message carries `total_cost_usd`, `usage`, `modelUsage`, `num_turns`, `duration_ms`, `session_id`, `structured_output`.
- **Structured output:** `outputFormat: { type: 'json_schema', schema }` (draft-07).
- **System prompt:** string, or `{ type: 'preset', preset: 'claude_code', append }`. `CLAUDE.md` of the target repo is loaded via `settingSources`.
- **Models:** aliases `fable`, `opus`, `sonnet`, `haiku`; IDs `claude-fable-5-1`, `claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-5-5`. `effort` low..max.

## 5. Decided architecture

### 5.1 Shape

pnpm monorepo, three apps and a small set of packages. No microservices.

```
apps/web        Next.js UI
apps/api        Fastify control plane: REST + WebSocket, scheduler, message bus, memory, approvals
apps/worker     Execution plane: Agent SDK sessions, worktrees, skill materialization, event streaming
packages/db     Prisma schema, migrations, client
packages/shared Zod schemas, event types, enums, worker protocol types
packages/runtime  RuntimeAdapter interface + Claude adapter + fake adapter
templates/agents  Chief, Architect, Developer, Designer, QA (seedable)
templates/skills  lazy-expert-developer, frontend-design, code-review, and the others listed in §7
infra/compose.yaml  Postgres (pgvector image), Redis
docs/           architecture, agent-lifecycle, memory-system, worker-protocol, development, security, progress
```

Packages beyond these are created only when two apps need the same code. Orchestrator, message bus, memory engine and skill registry start as modules inside `apps/api`.

### 5.2 Control plane vs execution plane

**Control plane (`apps/api`)** owns truth: agents, versions, skills, projects, tasks, DAG, scheduling, leases, message bus, memory, approvals, workers, events, audit. It never runs Claude itself; every Claude call, including planning, review and summarization, is a run leased to a worker.

**Execution plane (`apps/worker`)** connects outbound to the API over an authenticated WebSocket, registers capabilities and allowed workspace roots, heartbeats, receives leased runs, materializes the environment, runs the Agent SDK, streams normalized events, and reports results. It never decides what to run.

The first worker runs on this machine with `/home/meren/projects/maratus-admin` as an allowed workspace root. Remote workers use the same protocol later (Phase 5); nothing in the protocol assumes localhost.

### 5.3 Persistent identity, temporary execution

- `Agent` is the identity. `AgentVersion` is an immutable snapshot of its configuration (prompt, model, effort, tools, permissions, skills with pinned `SkillVersion` ids, allowed native subagents, limits).
- Every `TaskRun` and `AgentSession` references the `AgentVersion` it started with. Editing an agent creates a new version; running sessions are untouched.
- Agents are project-agnostic. Memory is scoped per (agent, project) and per project. The same Developer works on Maratus and on a greenfield project without mixing memories.

### 5.4 Specialist agents vs native subagents

Two separate concepts in the data model and the UI:

- **Specialist agent**: an `Agent` row with its own sessions, inbox, and memory (Architect, Developer, QA, Designer, Chief). Communicates over the message bus.
- **Native subagent**: a temporary Claude subagent (Debugger, Test Writer, Accessibility Reviewer) spawned inside a specialist's session through the SDK `agents` option. Recorded as `SubagentRun` under the parent `AgentSession`. It has no inbox and no memory of its own. Which subagents an agent may spawn, and how many, is part of `AgentVersion`.

## 6. Agents

### 6.1 Agent configuration

Name, description, role, system prompt, model (alias or id), effort, allowed tools, permission policy (deny rules, approval-required patterns), skills (each pinned to a version, with `eager` or `on_demand`), memory settings (which scopes it may read and propose to), worker preferences (tags), max budget per run (soft, passed as `maxBudgetUsd`) and per-day cap (hard, scheduler-enforced), max concurrent sessions, allowed native subagents with concurrency and depth, active flag.

### 6.2 Default team (seeded from `templates/agents`, editable)

| Agent | Default model | Skills |
|---|---|---|
| Chief | opus | planning, code-review |
| Architect | sonnet | clean-architecture, code-review |
| Developer | sonnet | lazy-expert-developer, test-driven-development, debugging, code-review, clean-architecture |
| Designer | sonnet | frontend-design, ui-ux-design, design-systems, accessibility, responsive-design, visual-quality-review |
| QA Engineer | sonnet | test-driven-development, code-review, debugging |

Model defaults are the builder's call for cost; the owner can switch any agent to `fable` in Agent Studio. Native subagent templates (Debugger, Test Writer, Security Reviewer, UX Researcher, Accessibility Reviewer, Visual Reviewer) ship alongside.

### 6.3 Human-to-agent chat is a real session

Chatting with the Developer in the UI starts or resumes an `AgentSession` of that agent, with its current `AgentVersion`, skills, project permissions, memory tools and inbox. If a session is live for that agent and project and accepts input, the message is delivered through streaming input; otherwise a new session starts, resuming the SDK session id when one is stored and still valid. No separate "chatbot" path exists.

## 7. Skills

### 7.1 Registry

`Skill` (identity, source: local path, git URL+ref, or authored in UI) and `SkillVersion` (immutable: full SKILL.md plus any supporting files, content checksum, created by, published flag). Editing a published version creates a new one. Import flows: local directory, git repository, UI editor. Imported skills enter `pending_review`; the owner approves them in the Skill Library before they can be assigned. Validation: SKILL.md present, frontmatter `name` and `description` present, name matches directory, size limit.

### 7.2 Assignment and materialization

`AgentSkill` links an agent to a skill with a pinned version and a loading mode. On version creation the pin is copied into the new `AgentVersion`.

When a run starts, the worker writes the pinned skill versions into the run's isolated environment under `<runRoot>/.office/.claude/skills/<name>/`, then passes that directory via `additionalDirectories` and the skill names via `skills`. Skills are never written into the target repository. Eager skills are also named explicitly in the system prompt with a one-line instruction to read them before starting; on-demand skills are only listed. The set of (skill, version, checksum) available to the run is recorded on `AgentSession`.

### 7.3 Shipped skills (`templates/skills`)

`lazy-expert-developer` (the spec's description, written as a real SKILL.md), `frontend-design`, `ui-ux-design`, `design-systems`, `accessibility`, `responsive-design`, `visual-quality-review`, `clean-architecture`, `test-driven-development`, `debugging`, `code-review`, `planning`. Each is short, concrete, Claude Code-compatible. Quality of these texts is the builder's responsibility; they are seed content, not product code.

## 8. Chief, tasks, scheduling, approvals

### 8.1 Mission flow

1. Owner submits a request in Mission Control against a project.
2. Chief runs a **planning session** on a read-only checkout (tools: read, grep, glob, git log; no edits, no bash writes) with `outputFormat` set to a plan schema: tasks with title, description, requirements, acceptance criteria, suggested agent, dependencies, parallel groups, approval points.
3. Backend validates the plan: DAG acyclic, agents exist and are active, every task has acceptance criteria. Stored as `Task` rows in `planned` state plus `TaskDependency` edges. Nothing runs.
4. Owner approves, edits, or rejects the plan in Mission Control (approval type `plan`).
5. Scheduler releases tasks whose dependencies are `done`, subject to §8.3.
6. On each task completion the Chief is notified (message bus). When all tasks of a mission finish, or one fails and retries are exhausted, the Chief runs a **review session**: reads the runs' summaries, diffs and test results, and writes the mission summary with evidence links. It may open follow-up tasks, which go through the same approval unless the approval policy allows small follow-ups.
7. Greenfield: identical, except step 2 runs in an empty initialized repository.

### 8.2 Task model

`Task`: title, description, requirements, acceptance criteria, priority, project, mission, parent task, assigned agent, kind (`code`, `analysis`, `review`), status, retry policy (max attempts, backoff), budget cap. `TaskDependency`: directed edges, cycle check on write. `TaskRun`: one attempt, with kind (`task`, `inbox`, `plan`, `review`, `summary`, `chat`), worker, lease, agent version, worktree, git result, check results, status, cost. Status machine for `Task`: `planned → ready → queued → running → waiting_reply | waiting_approval → running → review → done | failed | cancelled`, with `blocked` when a dependency failed. Transitions are implemented in one module with unit tests; nothing else writes `status`.

**`review → done`.** A task enters `review` when its run finishes and the worker has recorded the platform-side checks (§8.6). The Chief's review session (§8.1 step 6) moves it to `done` or reopens it with a note, and the owner can override either way from Mission Control. For `analysis` tasks the required evidence is at least one artifact or proposed memory entry; for `code` tasks it is a non-empty diff and a recorded check result; for `review` tasks it is a review artifact. A run that produces none of these cannot leave `review` as `done`, whatever the agent wrote.

### 8.3 Scheduler

Runs in `apps/api` on a short interval and on events. For each `ready` task it checks, in order: project allows the agent; agent is active and below its max concurrent sessions; agent's daily budget not exceeded; required capabilities (tags, repo access) matched by a connected worker with free capacity; approval policy satisfied. Then it creates a `TaskRun` with a **lease** (worker id, expiry) and sends the assignment. Workers renew leases with heartbeats. An expired lease marks the run `lost`; the task returns to `ready` if attempts remain. Duplicate completion is rejected by lease ownership check on every worker report.

### 8.4 Approval policies

Per project, with defaults: `plan` (always), `git_push`, `merge`, `deploy`, `destructive_command`, `sensitive_path`, `budget_exceeded`. Enforced in two places: the scheduler (plan, budget) and the worker's `canUseTool` callback (commands, paths, push). A pending approval pauses the tool call, emits `agent.waiting_approval`, and appears in the UI. Approval decisions are `Approval` rows with the deciding user and are audited. The Chief has no approval privileges.

While a tool call waits for approval the session stays alive: the lease is held, the worker slot stays occupied, no tokens are spent. A per-project `approvalTimeoutMinutes` (default 30) bounds the wait; on timeout the tool call is denied with an explanatory message and the agent continues and decides what to do. Stopping and resuming the session is not attempted in this build.

For Maratus the default `destructive_command` patterns include `npm run db:*`, `drizzle-kit *`, `git push`, `git reset --hard`, `rm -rf`, and anything touching `.env*`.

### 8.5 Git

One **mission branch** per mission: `office/<mission-slug>`, created from the project's default branch head when the plan is approved. Each `code` or `review` run gets its own worktree checked out at the mission branch head; the base commit is recorded on `GitWorkspace`. The agent commits inside the worktree (the worker sets the committer identity from project settings and adds an `Office-Agent:` trailer with the agent name and run id). On run success the worker fast-forwards the mission branch to the worktree head and removes the worktree. If the mission branch moved meanwhile (a parallel task finished first) the fast-forward fails; the run is marked `needs_integration`, its commits stay on `office/<mission-slug>/<task-slug>-<runId>`, and integration is a manual, approval-gated action in Mission Control. The Chief's planner is instructed to put dependent edits in sequence and to parallelize only tasks touching disjoint areas. A retry starts from the current mission branch head; the failed run's branch is kept for inspection and never fast-forwarded.

`analysis` runs (Architect) get a read-only checkout of the mission branch and produce artifacts and proposed memory entries, not commits, unless the task explicitly asks for a committed document.

Nothing is pushed or merged without approval. After a mission, Mission Control shows the mission branch, each task's commits and diff, and offers "push branch / open PR" as an approval-gated action.

### 8.6 Project execution settings and platform-side checks

Each project has: repository path (or clone URL for remote workers), default branch, package manager (detected from the lockfile, overridable), `setupCommand` (Maratus: `npm ci`), `checkCommand` (Maratus: `npm test`), optional `lintCommand`, an **env template** (a list of variable names with non-secret stand-in values that the worker writes to the configured file, `.env.local` for Maratus, inside each worktree), committer identity, approval policy, and limits.

After every `code` run the worker itself runs `checkCommand` in the worktree, captures exit code and output as an `Artifact`, and records a `CheckResult` on the run. This, not the agent's own Bash output, is what Mission Control's "Tests" chip reads. The agent may also run tests during its work; those are ordinary tool events.

Real secrets are never copied into worktrees. The env template exists so that env-validated modules can load; it is the owner's job to fill it with dummy values once per project in Settings.

## 9. Message bus and memory

### 9.1 Message bus

`Conversation` (project, kind: direct, group, task, human) and `Message` (conversation, sender agent or user, recipients, type: `message`, `question`, `handoff`, `help_request`, `escalation`, `artifact`, body, task reference, artifact references, idempotency key). `MessageDelivery` per recipient: `pending → delivered → acknowledged`. Everything is written before delivery; delivery to a live session is best-effort and the pending inbox is drained at the next session start.

Delivery to a running agent: the worker exposes a per-session input channel (streaming-input mode). The API pushes `inbox.new` to the worker; the worker injects a short "You have N new messages; call `read_inbox`" turn at the next safe boundary (after the current tool result, never mid-tool).

**Delivery to an agent with no live session (the common case, since tasks run in sequence).** A message of type `question`, `help_request`, `handoff` or `escalation` addressed to an agent with no live session makes the scheduler create an **inbox run** for that agent: `TaskRun.kind = inbox`, read-only checkout of the mission branch, read-only tools plus the messaging and memory tools, small `maxTurns` and budget, no worktree writes. The agent reads its inbox, answers, and the run ends. Plain `message` and `artifact` types do not wake anyone; they are read at the recipient's next session. Chief notifications on task completion are inbox runs of the Chief with a review-sized budget only when the mission's last task finishes; intermediate completions are plain messages.

**Waiting for a reply.** `send_message` accepts `awaitReply: true`. The run then stops at a controlled boundary: the worker ends the SDK turn, the run goes to `waiting_reply`, the lease is released and the worker slot freed. When the reply is delivered the scheduler resumes the run on any suitable worker with the SDK `resume` session id and the reply as the user message. Worktree and branch are kept across the wait. A `replyTimeoutMinutes` (default 60) returns the run to `running` with a "no reply received" message so the agent can proceed or escalate. Inbox runs may not themselves `awaitReply`; this, with the caps below, bounds the conversation depth.

MCP tools (server name `office`): `send_message`, `reply_message`, `read_inbox`, `get_conversation`, `list_agents`, `request_help`, `handoff_task`, `escalate_to_chief`. Loop limits enforced in the API: per-session message cap, per-task message cap, escalation depth 2, handoff chain length 3, and no agent may message itself. Limits are configurable in Settings.

### 9.2 Memory vs history

Raw history is always kept: `SessionEvent` (normalized events, sequence-numbered), `Message`, `TaskRun`, `Artifact`, `SubagentRun`. Curated knowledge is `MemoryEntry`: type (`decision`, `convention`, `api_contract`, `known_issue`, `lesson`, `task_summary`), scope (`project`, or `agent+project`, or `agent`), title, content, author (agent, user, or system), verification status (`proposed`, `verified`, `rejected`), version with `supersededBy`, and `MemorySource` rows pointing to the evidence (session event ids, message ids, commit shas, file paths, task run ids).

Only `verified` entries enter the shared context pack. Agent-proposed entries (`propose_memory`) are `proposed` until the owner verifies them in the Project Memory UI, except `task_summary` entries, which are generated by the system from run evidence and are `verified` on creation because they describe what happened, not what is true.

### 9.3 Automatic memory after a run

On `TaskRun` completion the API enqueues a **summary run** (`TaskRun.kind = summary`) for a built-in system agent, "Office Summarizer" (haiku by default, hidden from the team list, not assignable to tasks, no inbox). It is leased to a worker like any run, with no worktree and no repository tools; it reads the run's events, messages sent and received, diff stat and commit list, and the check artifact through the memory MCP server, and returns structured output. The API writes one `task_summary` (verified) and zero or more `proposed` decisions, lessons and known issues, each with sources. Summary runs never trigger further summary runs and are billed to the project under the system agent. Nothing is promoted automatically.

### 9.4 Retrieval and the context pack

Before a session starts, the API assembles a **context pack**: project overview entry if present, verified entries matching the task text (Postgres full-text search with `tsvector`, ranked, capped), the last N task summaries for this project, pending inbox messages, and the agent's own `agent` scope lessons. Size-capped; included as a system prompt section with entry ids so the agent can cite them.

MCP tools: `search_memory`, `read_memory`, `propose_memory`, `get_task_history`, `get_project_decisions`. All filtered by the session's project. The `MemoryEntry.embedding vector` column and pgvector extension are created in the schema now but unused; semantic search is a later addition requiring an embedding provider (Anthropic has none; Voyage or a local model would be the candidates).

## 10. Runtime adapter and events

```ts
interface RuntimeAdapter {
  start(spec: RunSpec, sink: EventSink, control: RunControl): Promise<RunResult>;
}
```

`RunSpec` carries the agent version, system prompt, context pack, materialized skill directory, worktree path, allowed tools, MCP server definitions, subagent definitions, limits, and resume session id. `EventSink.emit(event)` receives already-normalized application events. `RunControl` offers `sendUserMessage`, `interrupt`, `cancel`, and an approval resolver used by `canUseTool`.

Two implementations: `ClaudeAdapter` (Agent SDK) and `FakeAdapter` (deterministic script: given a scenario file it emits events, calls MCP tools, and returns results). The fake adapter lives under `packages/runtime/src/fake/` and is wired only when `OFFICE_RUNTIME=fake`.

Normalized events (name, payload sketch):

`agent.started`, `agent.thinking`, `agent.text`, `agent.tool.started`, `agent.tool.completed`, `agent.tool.failed`, `agent.file.changed`, `agent.command.executed`, `agent.subagent.spawned`, `agent.subagent.completed`, `agent.message.sent`, `agent.message.received`, `agent.waiting_approval`, `agent.approval.resolved`, `agent.completed`, `agent.failed`, `agent.cancelled`, `task.status.changed`, `run.lease.lost`, `worker.connected`, `worker.disconnected`, `memory.proposed`, `memory.verified`.

Every event has `seq` (per session, monotonic), `sessionId`, `agentId`, `projectId`, `taskRunId`, `ts`. Persisted in `SessionEvent`; large payloads (full tool output) go to a file-backed artifact store under `OFFICE_DATA_DIR` with a reference in the row. Secret redaction runs in the worker before emission (patterns for API keys, tokens, `.env` contents) and again in the API as a safety net. The WebSocket to the UI replays from a client-supplied `seq` on reconnect.

**Agent presence** is derived in the API from events, not stored by the LLM: `idle`, `working`, `messaging`, `delegating`, `waiting_approval`, `completed`, `failed`. A future 3D scene subscribes to the same WebSocket.

## 11. Workers

Enrollment: the owner creates a worker in the UI and gets a one-time enrollment token. The worker starts with that token, exchanges it for a long-lived worker credential stored locally, and connects via WebSocket. Heartbeat every 10 s with capacity and active runs; lease renewal rides on it. Disconnect marks the worker offline; its runs stay `running` until lease expiry (60 s), then `lost`. A reconnecting worker reports its still-running sessions; matching leases are re-attached instead of killed.

Allowed workspace roots are configured per worker. A run may only use a repository under an allowed root. Remote workers clone the project repository into their own root; they never see this machine's filesystem.

Cancellation: API sets run `cancelling`, worker calls `interrupt()` then kills the child after a grace period, reports `cancelled`.

## 12. Web application

Next.js App Router, Tailwind, shadcn/ui, TanStack Query, one WebSocket hook with replay, xterm.js only for the Agent Activity log view. Dark theme by default. Screens: Dashboard, Agent Studio, Skill Library, Mission Control, Conversations, Agent Inspector, Project Memory, Workers, Settings.

Mission Control is **evidence-linked**: every status chip (tasks, tests, git, memory saved) opens the record behind it: the run's event log, the diff, the test artifact, the memory entries with their sources. Chips are computed by the API from records, never from agent text.

Authentication for the single owner: a password set on first start, cookie session, one `User` row. API and WebSocket require it. Worker connections use worker credentials, never user sessions. No secrets are ever sent to the browser.

## 13. Observability details

Agent Activity View: structured event stream rendered as a log, filterable by tool, with the subagent tree. Interactive PTY shell is deferred to a later phase; the data model keeps a `shell` capability flag on workers so it can be added without schema change.

Cost: per run from `total_cost_usd` and `modelUsage`, rolled up per task, mission, agent, project and day in `UsageRecord`. The soft SDK budget and the hard scheduler budget are shown separately.

## 14. Security

Authenticated API and WS; worker auth and revocation; project authorization on every query (project id is always derived from the session, never from the tool argument alone); `permissionMode: 'default'` with explicit allow lists and deny rules; approval gates in `canUseTool`; workspace roots; secrets only in the worker environment; audit log for approvals, agent edits, skill approvals, memory verification; bounded retries, concurrency, messages, escalation depth; idempotent worker reports keyed by run id and seq. Imported skills, agent messages, tool output and memory content are untrusted input: rendered as text in the UI, never executed, never allowed to alter permissions.

## 15. Data model (entities)

User, Project, ProjectMember, ProjectAgent (which agents a project may use), Agent, AgentVersion, Skill, SkillVersion, AgentSkill, AgentSubagent, Worker, WorkerCapability, Mission, Task, TaskDependency, TaskRun, AgentSession, SubagentRun, SessionEvent, Conversation, Message, MessageDelivery, MemoryEntry, MemorySource, MemoryRevision, TaskSummary (a `MemoryEntry` of type `task_summary`; no separate table), Artifact, GitWorkspace, Approval, UsageRecord, AuditLog. Prisma migrations from day one; indexes on every foreign key, `(sessionId, seq)` unique, `(conversationId, createdAt)`, FTS index on `MemoryEntry`.

## 16. Testing

Unit: task state machine, DAG validation, scheduler decisions, lease ownership, message dedup and limits, agent versioning, skill pinning and materialization paths, memory permission filtering, event normalization, redaction. Integration (Postgres and Redis via Compose): bus delivery across restarts, memory FTS, approval pause and resume with the fake adapter. End-to-end with the fake adapter: the three-agent demo scenario runs to completion and the three success criteria are asserted against the database and API. Real-Claude tests live in a separate script, are opt-in, cost money, and their results are reported honestly in `docs/progress.md`.

## 17. Phases and acceptance

1. **Foundation.** Monorepo, Compose, Prisma, API skeleton, worker, Claude adapter, event stream, minimal UI. Accept: submit a task, local worker executes it through Claude, events and result appear in the UI.
2. **Agents and skills.** Registry, versions, skill library, materialization, native subagents, Agent Studio. Accept: Designer and Developer with different skills both run; sessions record exactly the pinned skill versions, and the skills are visibly invoked.
3. **Messaging and memory.** Bus, MCP tools, human chat as real session, summaries, memory, context pack, memory UI. Accept: two agents exchange messages, finish, memory saved, sessions closed and reopened, history and memory retrievable with sources.
4. **Chief and orchestration.** Planning session, DAG, scheduler, leases, approvals, retries, Mission Control. Accept: the Maratus mission runs end to end with Architect, Developer, QA; the three success criteria in §2 hold.
5. **Hybrid workers.** Enrollment, reconnection, remote clone, lease recovery. Accept: two tasks on two machines coordinated safely.
6. **Observability and hardening.** Inspector, cost views, audit, recovery tests, PTY shell if still wanted.

The three success criteria are the exit of Phase 4. Phases 5 and 6 come after they pass.

## 18. Left to the builder

- Exact Prisma field names and index set.
- Fastify plugin layout, Zod schema organization, error shape.
- Worker protocol message names, as long as they are typed in `packages/shared` and documented in `docs/worker-protocol.md`.
- Event payload details, as long as every event carries the common envelope in §10.
- UI component structure. Use shadcn defaults; no custom design system.
- Wording of the shipped skills and agent prompts.
- Choice of BullMQ for scheduler ticks and summarizer jobs versus a plain interval, as long as jobs survive an API restart.

## 19. Calls made during brainstorming (owner may overrule)

- pnpm installed globally; monorepo on pnpm workspaces.
- Postgres published on host port 5433; image `pgvector/pgvector:pg16` so the extension is available later.
- Chief defaults to `opus`, specialists to `sonnet`; overridable per agent.
- Keyword search (Postgres FTS) first; vector column present but unused.
- Single-owner password login; no multi-user features beyond the `User` table.
- Interactive PTY shell deferred to Phase 6.
- Auth to Claude is the worker environment's business; adapter is credential-agnostic.
- `CLAUDE.md` at the repo root holds the standing decisions and points to `docs/progress.md`, which is updated at the end of every phase.
- Agents with no live session are woken by `question`, `help_request`, `handoff` and `escalation` messages through bounded inbox runs; senders wait for replies by suspending their run (`awaitReply`), not by blocking a worker slot (§9.1).
- `review → done` is decided by the Chief's review session from platform-recorded evidence, with owner override (§8.2).
- One mission branch, per-run worktrees fast-forwarded on success, manual integration on conflict (§8.5).
- Worker runs the project's `checkCommand` after every code run; that output is the test evidence (§8.6).
- Real `.env.local` never enters a worktree; an owner-filled dummy env template does (§8.6).
- Approval waits keep the session alive up to `approvalTimeoutMinutes`, then deny (§8.4).
- Summaries are produced by a hidden system agent on a worker, not inside the API (§9.3).

## 20. Owner decisions (2026-10-31)

- **Required consultation is a configurable acceptance criterion**, set per task by the Chief's plan or by the owner, never mandatory for every task. A task carrying `requiredConsultations: [{ agent, topic }]` cannot leave `review` as `done` until, for each entry, a `question` message from the task's agent to that agent exists in a task-linked conversation and has a reply. The conversation is linked to the task as evidence.
- **Phase 4 acceptance has two parts, both required:** the deterministic fake-adapter end-to-end test, and a real Claude integration run against the Maratus repository. The real run must show (1) two independent Claude sessions communicating, (2) real code changes with independently executed tests, (3) independent QA verification, (4) evidence-based Chief review, (5) memory retrieval after all sessions are closed and restarted. It must not use production credentials, connect to the live Neon database, push, merge or deploy without explicit approval. It is not reported as passed until the execution evidence exists in the database and is reachable from Mission Control.
- **Retries** start from the latest safely integrated mission commit (the mission branch head after the last successful fast-forward), never from the mission's original base commit.
- **`waiting_reply` and `waiting_approval` are separate lifecycle states** on `TaskRun` and `Task`, with their own events and timeouts. Suspended-session recovery (resume after reply) and worker-slot release are verified by integration tests, not by inspection.
- Every success status in the UI links to the underlying session events, messages, git changes, check results or memory records.
