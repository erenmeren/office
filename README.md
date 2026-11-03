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

`.env` is git-ignored and must never be committed. Set at least `COOKIE_SECRET` to a random string of 32 characters or more, and `OFFICE_WORKSPACE_ROOTS` to the directory (or a colon-separated list of directories) under which the worker may run agents; the worker refuses to start if the list is empty or a directory does not exist. Include `<OFFICE_DATA_DIR>/repos` when you create projects without a repository path: the API initializes their repositories there. The other values match the Compose setup. The API listens on `127.0.0.1` only; set `API_HOST` (for example `0.0.0.0`) to expose it on other interfaces, which also exposes the unauthenticated first-run `/auth/setup`.

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

There is no separate projects page. The **New task** page has an "Add project" form (name, slug, repository path). The repository path must be under one of the worker's allowed workspace roots, or no worker will take the task. To run missions on an existing repository, add the repository directory (or its parent) to the worker's `OFFICE_WORKSPACE_ROOTS` in your local `.env`, and fill the project's env template in Settings before the first mission. The seeded `office-sandbox` project and `developer` agent are ready to use.

## 9. Skill Library (UI)

The **Skills** page lists every skill with its status (`approved`, `pending_review`, `rejected`), source and current version, and has buttons to approve or reject skills that are not approved. A skill is a directory with a `SKILL.md` whose frontmatter has single-line `name:` and `description:` entries (the name is lowercase letters, digits and hyphens), plus optional supporting files.

- **Create.** The "Create skill" form takes a name and the `SKILL.md` text. Skills written here are `approved` at once.
- **Import a skill directory.** In "Import skill", choose `local` and enter the directory's path. The path must be under one of `OFFICE_SKILL_IMPORT_ROOTS` (colon-separated; default `<repo>/templates/skills`), so to import your own skill, put it under an import root or add its parent directory to `OFFICE_SKILL_IMPORT_ROOTS` before starting the API. The skill's name is the directory name. Or choose `git` and enter an `https://` URL, an optional ref and an optional path inside the repository. Over the API: `POST /skills/import` with `{"source":"local","path":"..."}` or `{"source":"git","url":"https://...","ref":"main","path":"skills/my-skill"}` (or `"name":"my-skill"` instead of `path` to find the skill by its frontmatter name). "Marketplace" searches skills.sh and installs with `{"source":"market","id":"owner/repo/skill"}`. "Update" on a git or local skill (`POST /skills/:id/update`) re-reads its source and adds a version when it changed; "Delete" (`DELETE /skills/:id`) is refused while an agent version pins the skill.
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

A task without a mission still moves through `review` to `done` automatically when its run succeeds. Mission tasks wait for the Chief's evidence-based review (section 14).

## 14. Missions, approvals and settings (UI)

**Settings** (`/settings`) edits the selected project's execution settings: package manager, `setupCommand`, `checkCommand` (its output is the test evidence of every code run), check timeout, env file name and the dummy env template (names and values written into each worktree instead of the real env file), approval policies (`ask`, `auto` or `block` for plan, git push, merge, deploy, destructive commands, sensitive paths and budget overruns, plus the destructive patterns and sensitive paths), `approvalTimeoutMinutes` (default 30; a pending approval is then denied), daily and per-task budgets, concurrency, attempts, and the project's agents (none selected means every agent).

**Mission Control** (`/mission-control`): the Chief composer starts a mission from a request. The Chief's plan run reads the repository and proposes a task graph (analysis, code and review tasks, dependencies, required consultations, budgets). Review the plan, edit or replan it, then approve it. Tasks then run in per-run git worktrees under `<OFFICE_WORKER_HOME>/worktrees/` on run branches `office/<mission>-<id6>-runs/<task>-<run8>`. Code runs that commit are checked with `checkCommand` and fast-forwarded onto the mission branch `office/<mission>-<id6>` when the check passes, otherwise they are marked `needs_integration` for you to merge by hand. Nothing is pushed or merged into the default branch: a push is only ever an approval request.

Pending approvals appear on Mission Control with the tool call and the reason; approve once, approve for the whole task, or deny. A run waiting for you shows `waiting_approval` and keeps its session. When no task can run, the Chief's review run reads each task's recorded evidence (commits, check results, artifacts, consultations) and marks it done or reopens it with a note. You can override with **Done** or **Failed** on a task in review, raise a mission's budget cap, or cancel the mission (this cancels its live runs).

## 15. Remote workers on other machines

A worker is local for a project when it runs on the same machine as the API (its `hello` `machineId`, read from `/etc/machine-id` or the `OFFICE_MACHINE_ID` override, equals the API's) and its `OFFICE_WORKSPACE_ROOTS` cover the project's repository; only local workers receive the repository path and take chat, inbox, summary and non-mission task runs. A worker that sends no `machineId` (one built before Phase 5) is never local unless the API runs with `OFFICE_TRUST_UNIDENTIFIED_WORKERS=true`, so restart every worker after upgrading. Project `requiredWorkerTags` apply only to mission runs (plan, code, review); a worker started with `OFFICE_WORKER_CAN_CLONE=true` can also work on projects it cannot see, from its own clone. It clones from the API's git endpoint (`/git/<projectId>`, authenticated with the worker's credential) into `<OFFICE_WORKER_HOME>/repos/<projectId>` and pushes only `office/*` branches back, fast-forward only; the project's default branch and its own `origin` are never touched. Mission task, plan and review runs can go to such a worker; chat, inbox and summary runs stay on local workers. The scheduler prefers local workers. Tag workers with `OFFICE_WORKER_TAGS` (comma-separated, lowercase) and require tags per project under Settings, "Required worker tags".

On any other machine:

1. Start the API with `API_HOST=0.0.0.0` and make port 4000 reachable from that machine (put it behind TLS on an untrusted network).
2. Create a worker on the Workers page and copy its enroll token.
3. On the other machine: `OFFICE_API_URL=ws://<api-host>:4000 OFFICE_WORKER_CAN_CLONE=true OFFICE_WORKSPACE_ROOTS= OFFICE_WORKER_TAGS=<tags> OFFICE_ENROLL_TOKEN=<token> pnpm --filter @office/worker dev` (the token only on the first start; the credential is saved to `$OFFICE_WORKER_HOME/credentials.json`). The machine needs `git` and, for `OFFICE_RUNTIME=claude`, its own Claude login.

The Workers page shows each worker's mode (local, remote or none), tags, active runs, last heartbeat and a Revoke button; revoking also locks the worker out of the git endpoint at its next request.

### Remote worker container

`pnpm worker:remote` builds `infra/docker/worker.Dockerfile` and starts the `worker-remote` service (Compose profile `remote`). The container mounts nothing from the host: it clones project repositories from the API git endpoint (`OFFICE_WORKER_CAN_CLONE=true`, no workspace roots), keeps its credential and clones in the named volume `office-worker-remote` (`/office-worker`), and registers with the tag `remote`.

1. Start the API with `API_HOST=0.0.0.0` (the default `127.0.0.1` is not reachable from the container, which connects to `ws://host.docker.internal:4000`). This also exposes the API, including the first-run `/auth/setup`, on every interface.
2. A host firewall with default deny (for example ufw) drops the Docker bridge's traffic to port 4000. Choose one:
   - allow it: `sudo ufw allow from 172.16.0.0/12 to any port 4000 proto tcp` (the owner's choice; a system change), or
   - run the container on the host network with the opt-in override: add `-f infra/compose.hostnet.yaml` to the Compose command (step 4). The container then shares the host's network stack, so it is isolated from the host's filesystem but not from its network.
3. Create a worker (`POST /workers` or the Workers page) and copy its enroll token.
4. `OFFICE_REMOTE_ENROLL_TOKEN=<token> pnpm worker:remote`, or with the override `OFFICE_REMOTE_ENROLL_TOKEN=<token> docker compose -f infra/compose.yaml -f infra/compose.hostnet.yaml --profile remote up -d --build worker-remote`. Later starts need no token; the saved credential in the volume is used. Without a token or a saved credential the container exits with code 2 and `OFFICE_ENROLL_TOKEN required on first start`.
5. Check: the Workers page lists the worker `online` in mode remote with the tag `remote`; `docker inspect infra-worker-remote-1 --format '{{json .Mounts}}'` lists only the `office-worker-remote` volume. Stop it with `docker compose -f infra/compose.yaml --profile remote stop worker-remote`.

The runtime defaults to `fake`: its tasks need the `COMMIT:<path>:<text>` marker in their description to change files, and since plan and review runs can land on the container too, a fake container next to a real local worker can take the Chief's review (seen in the Phase 5 acceptance). `OFFICE_REMOTE_RUNTIME=claude` runs real Claude sessions, which needs the owner to provide Claude credentials inside the container; nothing is mounted or baked in for that. `OFFICE_REMOTE_WORKER_NAME` overrides the name (`remote-1`).

## 16. Dashboard, Live Sessions, Agent Inspector and Audit (UI)

These screens read stored records only (session events, subagent runs, usage records, audit rows, runs and approvals); no agent text sets a status. They show the first project.

- **Dashboard** (`/`): KPIs (active projects, agents available, running sessions, pending tasks, cost today against the daily budget), the team with each agent's status, current work and cost today, what needs your attention (pending approvals, skills to review), workers, recent activity (the stored feed plus live events of the project) and the 7-day cost chart. The same numbers come from `GET /projects/:id/overview`, `/costs?days=&groupBy=day|agent|mission|task` and `/activity`.
- **Live Sessions** (`/sessions`): every live run (running, waiting for a reply or an approval) with its agent, worker, task, cost and command and file counts; filters All, Running and Needs you; the selected session's detail panel has Stop, which cancels the run. `GET /sessions?projectId=&status=live|all`.
- **Agent Inspector** (`/sessions/<runId>`): one session's header (status, model, worker, running time, cost, Stop session), the activity feed that follows the run live (Pause following / Resume following), its commands, changed files, subagents and history, and the skills it ran with. Messages you send an agent are delivered at the next run boundary; there is no interrupt. `GET /sessions/:runId`, `GET /agents/:id/runs`.
- **Audit** (`/audit`): owner and system decisions, newest first, filtered by action, target type and date: plan and approval decisions, overrides, settings changes, `run.cancelled`, `worker.enrolled` and `worker.revoked`. `GET /audit?action=&targetType=&targetId=&since=&before=&limit=`.

Stopping a run (`POST /runs/:id/cancel`) marks it `cancelled` and writes an audit row; a mission task run returns its task to `ready` without using an attempt (add `?task=true` to cancel the task too).

Two environment variables are new in Phase 6 (both optional, see `.env.example`): `OFFICE_MACHINE_ID` replaces `/etc/machine-id` on the API and on workers of the same machine (for hosts without one), and `OFFICE_GIT_TIMEOUT_SECONDS` (default 600) limits one request on the git endpoint.

## 17. Desktop app (Linux)

`apps/desktop` packages the whole stack as one Electron app, so Docker, `.env` and the three dev servers are not needed. The app starts a bundled Postgres 17 (`@embedded-postgres/linux-x64`, TCP on `127.0.0.1:5440`, scram password generated on first run), runs `apps/desktop/server/boot.mjs` (creates the `office` database, applies `packages/db/prisma/migrations` with Prisma's `_prisma_migrations` bookkeeping, seeds, enrolls the bundled worker), then the API on `127.0.0.1:4100`, the Next.js standalone server on `127.0.0.1:3100` and the local worker (`claude` runtime, capacity 2, name `desktop`), and opens the UI in a window. Closing the window stops everything, Postgres included.

```bash
pnpm --filter @office/desktop bundle   # builds api/worker/db, the web standalone build, pnpm deploy into apps/desktop/build
pnpm --filter @office/desktop start    # run unpackaged from apps/desktop/build
pnpm --filter @office/desktop dist     # bundle + AppImage in apps/desktop/release/office-<version>.AppImage
pnpm --filter @office/desktop install-desktop  # copy release/linux-unpacked to ~/.local/lib/office, icon + office.desktop (menu and Desktop)
```

State lives under `$XDG_DATA_HOME/office` (default `~/.local/share/office`): `pg/` (database cluster), `data/` (`OFFICE_DATA_DIR`: artifacts, greenfield repositories under `data/repos`), `workspaces/` (the seeded sandbox repository), `worker/` (worker home and credential), `logs/` (`postgres.log`, `boot.log`, `api.log`, `web.log`, `worker.log`), `pg-password` and `cookie-secret` (0600). `OFFICE_DESKTOP_DATA` overrides the directory.

Optional `~/.local/share/office/env` holds `KEY=VALUE` lines passed to the API and the worker; `OFFICE_WORKSPACE_ROOTS` there is appended to the defaults (`workspaces` and `data/repos`), so add the repositories you want missions to run on, e.g. `OFFICE_WORKSPACE_ROOTS=/home/me/projects`. The worker uses the machine's Claude Code login as usual. Limits: Linux x64 only; the bundled Postgres has no pgvector, so the unused `embedding` column is created with a stub `vector` type (`apps/desktop/pgstub`); the ports 5440, 4100 and 3100 are fixed (the web bundle is built with `NEXT_PUBLIC_API_URL=http://127.0.0.1:4100`); the Docker database is not migrated into the app. The AppImage (about 420 MB) needs `libfuse.so.2` (`fuse2` on Arch-based systems); without it run `release/linux-unpacked/office` or extract with `--appimage-extract`.

## Claude authentication

The worker inherits the machine's Claude Code login (`claude login`) or `ANTHROPIC_API_KEY`; nothing is configured in Agent Office itself.

## Commands

- `pnpm infra:up` / `pnpm infra:down`: start or stop Postgres and Redis.
- `pnpm db:migrate`: apply Prisma migrations.
- `pnpm seed`: seed the sandbox project, the shipped skills, the default team and the hidden `office-summarizer` agent.
- `pnpm dev`: run all packages in watch mode (export `.env` first, or use `scripts/dev-all.sh`).
- `pnpm typecheck`, `pnpm test`, `pnpm build`.

More detail: `docs/development.md`, `docs/worker-protocol.md`, `docs/security.md`.
