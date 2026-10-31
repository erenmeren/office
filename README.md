# Claude Agent Office

A control plane that turns Claude Code sessions into a persistent AI software team. Phase 1 (foundation) is the current state; see `docs/progress.md` for what is done and what is outstanding.

## 1. What it is

Agent Office has three apps and a few shared packages in one pnpm monorepo:

- `apps/api` is the control plane (Fastify, port 4000). It owns agents, projects, tasks, runs, leases, workers and the event log. It never runs Claude itself.
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

`.env` is git-ignored and must never be committed. Set at least `COOKIE_SECRET` to a random string of 32 characters or more, and `OFFICE_WORKSPACE_ROOTS` to the directory (or a colon-separated list of directories) under which the worker may run agents. The other values match the Compose setup.

The API and the worker read their configuration from the process environment only, so export `.env` into the shell before starting them by hand:

```bash
set -a; . ./.env; set +a
```

`scripts/dev-all.sh` does this for you, then starts infra, applies migrations and runs `pnpm dev`.

## 6. Seed

```bash
pnpm seed
```

The seed creates the project `office-sandbox` with its repository at `<first OFFICE_WORKSPACE_ROOTS entry>/office-sandbox` (the directory is created and `git init` is run if it is missing), and the agent `developer` (model `sonnet`, tools Read, Glob, Grep, Bash, Edit, Write, 30 turns, budget 1 USD). It is idempotent by slug: a second run prints "exists" and changes nothing.

## 7. Owner setup and login (UI)

Start the API and the web app (with `.env` exported):

```bash
pnpm --filter @office/api dev
pnpm --filter @office/web dev
```

Open http://localhost:3000. On the first visit no owner exists yet, and the login page asks you to set an email and a password (at least 8 characters). This creates the single owner account. Later visits ask for the same email and password.

## 8. Project and agent (UI)

The **Agents** page lists agents with their current version and has a form to create an agent (name, slug, role, system prompt, model, allowed tools, turn and budget limits). Editing an agent is done through the API in Phase 1 (`PUT /agents/:id`); every configuration change creates a new immutable agent version, and runs already started keep the version they started with. Agent Studio comes in Phase 2.

Phase 1 has no separate projects page. The **New task** page has an "Add project" form (name, slug, repository path). The repository path must be under one of the worker's allowed workspace roots, or no worker will take the task. The seeded `office-sandbox` project and `developer` agent are ready to use.

## 9. Enroll a worker (UI)

On the **Workers** page, create a worker with a name. The page shows a one-time enrollment token and the command to start the worker with it:

```bash
set -a; . ./.env; set +a
OFFICE_ENROLL_TOKEN=<token> pnpm --filter @office/worker dev
```

The worker exchanges the token for a long-lived credential, saves it to `$OFFICE_WORKER_HOME/credentials.json` (mode 0600, default `~/.office-worker`), and connects. Later starts need no token:

```bash
pnpm --filter @office/worker dev
```

The token is shown only once and only its hash is stored. Revoking a worker (`DELETE /workers/:id`; there is no button for it in Phase 1) closes its connection and invalidates its credential.

## 10. Messaging and memory

Phase 3. Agent-to-agent messages, the inbox, task summaries and project memory are not built yet. See `docs/progress.md`.

## 11. Submit a task and watch events

On the **New task** page pick a project and an agent, enter a title and a description, and submit. The scheduler assigns the task to an online worker whose allowed roots contain the project's repository path. The task page then shows the run status and a live event log (`agent.started`, `agent.tool.started`, `agent.command.executed`, `agent.file.changed`, `agent.text`, `agent.completed` with cost, and so on). Events are stored in the database; reloading the page, or restarting the API, replays them from there.

In Phase 1 a successful run moves the task through `review` to `done` automatically. Evidence-based review by the Chief comes in Phase 4.

## 12. Remote workers on other machines

Phase 5. The worker protocol does not assume localhost, but remote clone, remote workspace roots and multi-machine coordination are not built or tested yet. See `docs/progress.md`.

## Claude authentication

The worker inherits the machine's Claude Code login (`claude login`) or `ANTHROPIC_API_KEY`; nothing is configured in Agent Office itself.

## Commands

- `pnpm infra:up` / `pnpm infra:down`: start or stop Postgres and Redis.
- `pnpm db:migrate`: apply Prisma migrations.
- `pnpm seed`: seed the sandbox project and the developer agent.
- `pnpm dev`: run all packages in watch mode (export `.env` first, or use `scripts/dev-all.sh`).
- `pnpm typecheck`, `pnpm test`, `pnpm build`.

More detail: `docs/development.md`, `docs/worker-protocol.md`, `docs/security.md`.
