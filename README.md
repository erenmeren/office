# Claude Agent Office

A control plane that turns Claude Code sessions into a persistent AI software team. Phases 1 (foundation), 2 (agents and skills) and 3 (messaging and memory) are done; see `docs/progress.md` for what is done and what is outstanding.

## 1. What it is

Agent Office has three apps and a few shared packages in one pnpm monorepo:

- `apps/api` is the control plane (Fastify, port 4000). It owns agents, skills, projects, tasks, runs, leases, workers and the event log. It never runs Claude itself.
- `apps/worker` is the execution plane. It connects outbound to the API over a WebSocket, receives leased runs, runs them through the Claude Agent SDK, and streams normalized events back.
- `apps/web` is the owner's UI (Next.js, port 3000).
- `packages/shared` (Zod schemas and protocol types), `packages/db` (Prisma schema, migrations, seed) and `packages/runtime` (Claude and fake adapters, secret redaction).

The design is in `docs/superpowers/specs/2026-10-31-agent-office-design.md`. A shorter overview is in `docs/architecture.md`.

## 2. Prerequisites

- Node.js (developed and tested on Node 26).
- pnpm, installed globally (`npm install -g pnpm`).
- Docker with Compose, for Postgres and Redis.
- Git.
- Claude Code, logged in on the machine that runs the worker (see "Claude authentication" below).

## 3. Install

```bash
pnpm install
```

## 4. Infra and migrations

```bash
pnpm infra:up      # Postgres on host port 5433, Redis on host port 6380
pnpm db:migrate    # apply Prisma migrations to the dev database
```

`pnpm infra:up` is idempotent. `pnpm infra:down` stops the containers and keeps the data volume.

## 5. Configuration (.env)

Copy the template and edit it:

```bash
cp .env.example .env
```

`.env` is git-ignored and must never be committed. Set at least `COOKIE_SECRET` to a random string of 32 characters or more, and `OFFICE_WORKSPACE_ROOTS` to the directory (or a colon-separated list of directories) under which the worker may run agents; the worker refuses to start if the list is empty or a directory does not exist. The other values match the Compose setup. The API listens on `127.0.0.1` only; set `API_HOST` (for example `0.0.0.0`) to expose it on other interfaces, which also exposes the unauthenticated first-run `/auth/setup`.

The API and the worker read their configuration from the process environment only; they do not load `.env` themselves. For the API and the web app, export `.env` into the shell before starting them by hand:

```bash
set -a; . ./.env; set +a
```

The worker needs only the `OFFICE_*` variables: `OFFICE_API_URL`, `OFFICE_WORKER_HOME`, `OFFICE_WORKSPACE_ROOTS`, `OFFICE_RUNTIME`, `OFFICE_WORKER_CAPACITY`, and optionally `OFFICE_ENROLL_TOKEN` and `OFFICE_WORKER_NAME`. Agent sessions inherit the worker's environment minus `CLAUDE*`, `AI_AGENT`, `DATABASE_URL*`, `COOKIE_SECRET`, `REDIS_URL` and `OFFICE_*`; any other secret exported into the worker's shell reaches every agent session. Export only the `OFFICE_*` variables for the worker (see section 11 and `docs/security.md`).

`scripts/dev-all.sh` exports the whole `.env` for convenience, then starts infra, applies migrations and runs `pnpm dev`. Because it starts the worker too, use it only with throwaway local values.

## 6. Seed

```bash
pnpm seed
```

The seed creates the project `office-sandbox` with its repository at `<first OFFICE_WORKSPACE_ROOTS entry>/office-sandbox` (the directory is created and `git init` is run if it is missing), and the agent `developer` (model `sonnet`, tools Read, Glob, Grep, Bash, Edit, Write, 30 turns, budget 1 USD). It also loads the shipped templates: the 12 skills in `templates/skills` (`accessibility`, `clean-architecture`, `code-review`, `debugging`, `design-systems`, `frontend-design`, `lazy-expert-developer`, `planning`, `responsive-design`, `test-driven-development`, `ui-ux-design`, `visual-quality-review`), created `approved`, and the default team from `templates/agents`, with subagents from `templates/subagents`:

| Agent | Model | Eager skills | On-demand skills | Subagents |
|---|---|---|---|---|
| `chief` | `opus` | planning | code-review | none |
| `architect` | `sonnet` | clean-architecture | code-review | none |
| `designer` | `sonnet` | frontend-design | ui-ux-design, design-systems, accessibility, responsive-design, visual-quality-review | ux-researcher, accessibility-reviewer, visual-reviewer |
| `qa-engineer` | `sonnet` | test-driven-development | code-review, debugging | test-writer, security-reviewer |
| `developer` | `sonnet` | lazy-expert-developer, test-driven-development | debugging, code-review, clean-architecture | debugger, test-writer |

It also creates the hidden system agent `office-summarizer` (model `haiku`), which writes a summary of every finished task run into Project Memory. Agents cannot message it and it is never woken by mail; the sidebar's team list still shows it.

The seed is idempotent by slug and name: a second run prints "exists" and changes nothing. An agent that already exists is left as it is; in particular a `developer` created by the Phase 1 seed stays at version 1 without skills or subagents until you give it a new version in Agent Studio.

## 7. Owner setup and login (UI)

Start the API and the web app (with `.env` exported):

```bash
pnpm --filter @office/api dev
pnpm --filter @office/web dev
```

Open http://localhost:3000. On the first visit no owner exists yet, and the login page asks you to set an email and a password (at least 8 characters). This creates the single owner account. Later visits ask for the same email and password.

## 8. Project and agent (UI)

The **Agents** page lists agents with their current version and has a form to create an agent (name, slug, role, system prompt, model, allowed tools, turn and budget limits). Each agent's name links to its Agent Studio page (section 10). Every configuration change creates a new immutable agent version, and runs already started keep the version they started with.

Phase 1 has no separate projects page. The **New task** page has an "Add project" form (name, slug, repository path). The repository path must be under one of the worker's allowed workspace roots, or no worker will take the task. The seeded `office-sandbox` project and `developer` agent are ready to use.

## 9. Skill Library (UI)

The **Skills** page lists every skill with its status (`approved`, `pending_review`, `rejected`), source and current version, and has buttons to approve or reject skills that are not approved. A skill is a directory with a `SKILL.md` whose frontmatter has single-line `name:` and `description:` entries (the name is lowercase letters, digits and hyphens), plus optional supporting files.

- **Create.** The "Create skill" form takes a name and the `SKILL.md` text. Skills written here are `approved` at once.
- **Import a skill directory.** In "Import skill", choose `local` and enter the directory's path. The path must be under one of `OFFICE_SKILL_IMPORT_ROOTS` (colon-separated; default `<repo>/templates/skills`), so to import your own skill, put it under an import root or add its parent directory to `OFFICE_SKILL_IMPORT_ROOTS` before starting the API. The skill's name is the directory name. Or choose `git` and enter an `https://` URL, an optional ref and an optional path inside the repository. Over the API: `POST /skills/import` with `{"source":"local","path":"..."}` or `{"source":"git","url":"https://...","ref":"main","path":"skills/my-skill"}`.
- **Review.** Imported skills start as `pending_review`. Read the files on the skill's page, then approve or reject. Only approved skills can be pinned to an agent.
- **Versions.** A skill's page shows its files and versions. "Save new version" stores edited content as a new immutable version; saving identical content creates nothing.

## 10. Agent Studio (UI)

Open an agent from the **Agents** page. Agent Studio edits the whole agent configuration and saves it with "Save as new version":

- system prompt, model, effort, allowed tools, turn and budget limits, subagent limits;
- **skill pins:** tick approved skills, choose the mode (`eager`: the agent is told to invoke it before doing anything else; `on_demand`: listed as available when relevant) and optionally pin an older version (the default is the skill's current version);
- **subagents:** name, description, prompt, optional model, tools, and the pinned skills each may use.

The Versions table lists every version with its pins and subagents. A run uses the version that was current when it was assigned. The task page shows the skills the session ran with, the `agent.skill.invoked` and subagent events, and a Subagents card.

When a version pins skills, the worker writes them to `<OFFICE_WORKER_HOME>/runs/<runId>/.office` for that run only and removes them afterwards; the project repository is not touched. See `docs/architecture.md` and `docs/security.md`.

## 11. Enroll a worker (UI)

On the **Workers** page, create a worker with a name. The page shows a one-time enrollment token and the command to start the worker with it:

```bash
set -a; . <(grep '^OFFICE_' .env); set +a   # only the worker's variables
OFFICE_ENROLL_TOKEN=<token> pnpm --filter @office/worker dev
```

The worker exchanges the token for a long-lived credential, saves it to `$OFFICE_WORKER_HOME/credentials.json` (mode 0600, default `~/.office-worker`), and connects. Later starts need no token, only the same `OFFICE_*` variables:

```bash
pnpm --filter @office/worker dev
```

The token is shown only once and only its hash is stored. Revoking a worker (`DELETE /workers/:id`; there is no button for it in Phase 1) closes its connection and invalidates its credential.

## 12. Conversations and Project Memory (UI)

Agents talk to each other and to you through office tools (`send_message`, `reply_message`, `read_inbox`, `request_help`, `handoff_task`, `escalate_to_chief`, `propose_memory`, `search_memory` and others). Every message is saved before it is delivered.

**Conversations** (`/conversations`) lists direct, task, group and owner threads with the last message, filters by kind, and searches message text. A thread shows each message with its type and delivery state, the linked task and the participants. "Message an agent" and "New group" start a conversation, and the composer sends a `Note` or a `Question`. A question wakes an idle agent: the scheduler starts a short `chat` run that answers in the same conversation, resuming the conversation's Claude session. Mail reaches a running agent only at a session boundary (when it reads its inbox or at its next run).

An agent can ask another agent a question and wait (`awaitReply`). Its run then shows `waiting_reply` and frees its worker slot. The recipient is woken by an `inbox` run if it is idle, and the reply resumes the waiting run in the same Claude session. Without a reply the run resumes after `OFFICE_REPLY_TIMEOUT_MINUTES` (default 60). A task page links to its task thread.

**Project Memory** (`/memory`) lists the project's decisions, conventions, API contracts, known issues, lessons and task summaries, with search and type filters. Agents propose entries; they stay `Needs review` until you verify or reject them, and only verified entries are given to agents. "Add memory" creates a verified entry. Each entry shows where it came from (run, task, message, file) and its revisions; editing creates a new revision, and deleting removes the entry for good. After every finished task run `office-summarizer` adds a verified task summary.

Before each run the agent gets a context pack: the project overview, relevant verified memory, recent task summaries, its unread inbox and its lessons. The task page shows which entries were included.

Limits (messages per session and per task, escalation depth, handoff chain, reply timeout, context pack size) are environment variables; see `docs/development.md`.

## 13. Submit a task and watch events

On the **New task** page pick a project and an agent, enter a title and a description, and submit. The scheduler assigns the task to an online worker whose allowed roots contain the project's repository path. The task page then shows the run status and a live event log (`agent.started`, `agent.tool.started`, `agent.command.executed`, `agent.file.changed`, `agent.skill.invoked`, `agent.text`, `agent.completed` with cost, and so on). Events are stored in the database; reloading the page, or restarting the API, replays them from there.

Until Phase 4 a successful run moves the task through `review` to `done` automatically. Evidence-based review by the Chief comes in Phase 4.

## 14. Remote workers on other machines

Phase 5. The worker protocol does not assume localhost, but remote clone, remote workspace roots and multi-machine coordination are not built or tested yet. See `docs/progress.md`.

## Claude authentication

The worker inherits the machine's Claude Code login (`claude login`) or `ANTHROPIC_API_KEY`; nothing is configured in Agent Office itself.

## Commands

- `pnpm infra:up` / `pnpm infra:down`: start or stop Postgres and Redis.
- `pnpm db:migrate`: apply Prisma migrations.
- `pnpm seed`: seed the sandbox project, the shipped skills, the default team and the hidden `office-summarizer` agent.
- `pnpm dev`: run all packages in watch mode (export `.env` first, or use `scripts/dev-all.sh`).
- `pnpm typecheck`, `pnpm test`, `pnpm build`.

More detail: `docs/development.md`, `docs/worker-protocol.md`, `docs/security.md`.
