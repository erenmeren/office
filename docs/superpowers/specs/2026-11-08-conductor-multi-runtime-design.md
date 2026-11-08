# Conductor and multi-runtime agents (2026-11-08)

Owner brief: "Claude Agent Office — Conductor ve Multi-Model Orchestration". This document is the brief's first deliverable (gap analysis and design) and the record of what was built from it.

## 1. Current architecture (before this work)

- Control plane: Fastify API with Prisma on Postgres. The `Scheduler` ticks every 2 s: it plans missions, resumes waiting runs, assigns ready tasks, pushes live mail, wakes idle agents and starts summaries and reviews.
- Execution: workers connect over a WebSocket and run a `RunSpec` through a `RuntimeAdapter`. The adapter is `ClaudeAdapter` (Claude Agent SDK) or `FakeAdapter` (tests), chosen once per worker by `OFFICE_RUNTIME`.
- Projects own everything: repository, settings (approval policy, budgets, network), team (`ProjectAgent`), memory, conversations, missions, runs. Every `TaskRun`, `Conversation` and `Message` has a `projectId`.
- Per project, the Chief plans a mission (read-only `plan` run), the owner (or the `plan: auto` policy) approves, tasks run in per-run worktrees, the worker runs `checkCommand`, a clean run is fast-forwarded onto the mission branch, and the Chief's `review` run decides each task from recorded evidence.
- Agents are persistent rows with versioned config (`AgentVersion`: prompt, model, tools, skills, subagents, budget). Sessions are temporary: each run builds a context pack (memory, summaries, inbox) and a chat resumes its SDK session.
- Manual work: CLI sessions are read live, the owner's own `claude` runs under a PTY, background agents, and handoffs between missions and manual sessions.
- Safety: the approval gate is a `PreToolUse` hook in the Claude adapter. File tools are confined to the worktree, and Bash runs in the SDK sandbox unless `networkAccess` is `open`. Hard mission and soft daily budgets are enforced through the SDK's `maxBudgetUsd` and the scheduler's gate.

## 2. Existing vs missing

| Brief item | State before | Done here |
|---|---|---|
| Per-project Chief, team, memory, worktrees | Built (Phases 2–6) | Unchanged |
| Persistent agents, ephemeral sessions | Built (context pack, resume, inbox wake) | Unchanged |
| Manual Claude Code sessions | Built (unified sessions Phases 1–4) | Unchanged |
| Global Conductor above projects | Missing | Built (section 3) |
| Runtime adapter interface | Built, Claude only, one runtime per worker | Runtime per agent, worker announces its runtimes |
| OpenAI Codex runtime | Missing | Built as `CodexAdapter` (section 4), with stated limits |
| Gemini, Kimi | Missing | Not built; the adapter interface and `runtime` enum are where they go |
| Model router | Per-agent model only | Rule table per project, decision recorded per run (section 5) |
| Usage and cost per runtime | Claude USD from the SDK | Codex tokens recorded; USD is 0 (see 4.4) |
| Security rules of the brief | Approval gate, sandbox, budgets exist; owner defaults are `auto` everywhere and `networkAccess` `open` | Unchanged; tightening them is the owner's decision (see 7) |

## 3. Conductor

### 3.1 What it is

A hidden system agent, `conductor`, that the owner talks to on the Conductor page. It decides which project a request belongs to, splits a request that spans projects into one mission per project, and reports their state. It never writes code, never changes files, never runs commands or tests, and never reads a project's source code. Its only lever is opening missions, which then go through the normal per-project flow (Chief plan, plan approval policy, worktrees, check, Chief review).

### 3.2 Where it lives

Every run, conversation and message needs a project, so the Conductor has a home project: `office-conductor`, created at API start, marked `Project.isSystem`, with a repository under `<OFFICE_DATA_DIR>/repos/office-conductor` that holds nothing but the starter files. System projects are left out of `GET /projects`, so the switcher, Dashboard and Mission Control never show it. The home project gives the Conductor everything the platform already has for a chat: wake runs, SDK session resume per conversation, events, usage, budget (the home project's daily budget is the Conductor's budget) and the session pages.

Rejected alternative: making `projectId` nullable on runs, conversations and messages. Every query, gate and page assumes a project; the change would touch most of the API for no gain over a hidden home project.

### 3.3 Tools

A Conductor run gets no built-in tool at all (SDK `tools: []`, so not even Read, Glob, Grep, nor the CLI's newer tools such as Workflow), and its office tools are a separate set:

- `list_projects`: slug, name, default branch, team, live mission count.
- `get_project`: team, recent missions with status and summary, verified decisions.
- `search_project_memory`: verified memory of one project.
- `create_mission`: opens a mission in a project (by slug) with the request text, optional title and budget; records the Conductor conversation on the mission.
- `list_missions` and `get_mission`: status, tasks, summary and what the mission waits for.

The tools act on project records only. The source code of a project is never readable by the Conductor, so the brief's rule on cross-project source access holds by construction.

### 3.4 Ambiguity

The Conductor's prompt tells it to ask the owner, and open nothing, when the target project is unclear, and to name the project before it opens a mission. `create_mission` refuses an unknown slug and lists the valid ones.

### 3.5 Owner view

`/conductor`: the Conductor conversations (new, list, thread, composer) and, for the open conversation, the missions it opened with their live status and a link into Mission Control.

## 4. Codex runtime

### 4.1 Selection

`AgentConfig.runtime`: `claude` (default) or `codex`. A worker announces the runtimes it can run in `hello` (`runtimes`); `codex` is announced when the `codex` binary answers `--version`. The scheduler only gives a run to a worker that has its runtime. `OFFICE_RUNTIME=fake` still replaces every runtime in tests.

### 4.2 Adapter

`CodexAdapter` spawns the installed CLI: `codex exec --json --sandbox workspace-write --cd <cwd> [--add-dir <gitDir>] -c approval_policy="never" -c sandbox_workspace_write.network_access=<bool> [--model <m>] -` with the prompt on stdin, or `codex exec … resume <threadId> -` to resume. It maps the JSONL events (`thread.started`, `item.*` with `agent_message`, `command_execution`, `file_change`, `mcp_tool_call`, `todo_list`, `error`, `turn.completed`, `turn.failed`, `error`) to Office events and the `RunResult`. The `@openai/codex-sdk` package does the same spawn and was read to confirm the event shapes; it is not added as a dependency because it pins its own copy of the CLI binary.

### 4.3 Approvals and confinement

Codex has no hook the platform can answer per tool call. Instead:

- Writes are confined by Codex's own sandbox (`workspace-write`: the working directory plus the worktree's git directory).
- `approval_policy=never`: nobody answers prompts on a worker; a command the sandbox refuses fails.
- Network is on only when the project's `networkAccess` is `open` and its `git_push` and `deploy` policies are `auto`; otherwise off (Codex has no per-domain allowlist, so `allowlist` means off).
- A project whose `destructive_command` or `sensitive_path` policy is not `auto` cannot run Codex agents: the run fails at start and says why, because those policies cannot be enforced without a per-call gate.

### 4.4 Capabilities and limits

| Capability | Claude | Codex |
|---|---|---|
| Task runs (code, verify, analysis, review tasks) | yes | yes |
| Chat, inbox, plan, review, summary, Conductor runs | yes | no (Chief, summarizer, Conductor stay on Claude) |
| Office tools (messaging, memory) | yes | no (no MCP bridge yet) |
| Interrupt and send, Pause, resume | yes | yes (process stopped, `exec resume <thread>`) |
| Live message delivery | yes | no (mail waits for the next run) |
| Skills, subagents | yes | no |
| Budget cap inside a run | yes (SDK) | no: usage arrives at the end of the turn |
| Cost | USD from the SDK | tokens recorded, USD 0: a ChatGPT-plan login has no per-token price and Office does not invent one |

## 5. Model router

A project setting `routing`: an ordered list of rules `{ taskKind?, minPriority?, runtime, model? }`. For a task run the first matching rule wins; otherwise the agent's own runtime and model apply. The decision and its reason are stored on the run (`TaskRun.routing`: `{ runtime, model, reason }`) and shown with the run. When the chosen runtime has no worker online, the run falls back to the agent's own runtime, and the reason says so. Rules never route chat, inbox, plan, review, summary or Conductor runs. No model scores task complexity: a scoring call costs money and is not reproducible; priority and kind are the owner's signals.

## 6. File impact map

- `packages/db/prisma/schema.prisma` and migration: `Project.isSystem`, `Mission.conductorConversationId`, `TaskRun.routing`.
- `packages/shared`: `office-tools.ts` (Conductor tools), `agent-config.ts` (`runtime`), `run-spec.ts` (`runtime`, `noBuiltinTools`), `protocol.ts` (`hello.runtimes`), `policy.ts` (`routing` setting).
- `packages/runtime`: `codex/adapter.ts`, `codex/normalize.ts` and tests; `claude/adapter.ts` honours `noBuiltinTools`.
- `apps/worker`: adapter per runtime, `runtimes` in `hello`.
- `apps/api`: `services/conductor-service.ts` (home project, tools), `tool-service.ts` (Conductor tool set), `run-service.ts` (spec fields, routing), `scheduler.ts` (wake the Conductor, runtime-aware worker pick, routing), `ws/worker-gateway.ts` (`runtimes`), `routes/projects.ts` (hide system projects), `routes/conductor.ts`.
- `apps/web`: `/conductor` page, nav entry, agent form runtime field, run routing line.
- `templates/agents/conductor.json`.
- Docs: `CLAUDE.md`, `docs/progress.md`, `docs/architecture.md`, `docs/worker-protocol.md`, `docs/development.md`.

## 7. Decisions left to the owner

- The approval policy is `auto` everywhere and `networkAccess` is `open` by the owner's choice of 2026-11-04. The brief asks for approval on risky actions; with Codex agents (no per-call gate) that choice matters more. Not changed here.
- Codex needs a login on the worker's machine (`codex login`, or `CODEX_API_KEY` in the worker environment). Without it a Codex run fails with the CLI's 401 message.
