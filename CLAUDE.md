# Claude Agent Office

A control plane that turns Claude Code sessions into a persistent AI software team.

- Spec: `docs/superpowers/specs/2026-10-31-agent-office-design.md`
- Plan: `docs/superpowers/plans/2026-10-31-phase1-foundation.md`
- Progress: `docs/progress.md`

## Standing decisions (spec §19, §20)

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
- Required consultation is a configurable acceptance criterion, set per task by the Chief's plan or the owner, never mandatory for every task. A task with `requiredConsultations: [{ agent, topic }]` cannot leave `review` as `done` until, for each entry, a `question` message from the task's agent to that agent exists in a task-linked conversation and has a reply.
- Phase 4 acceptance has two parts, both required: the deterministic fake-adapter end-to-end test, and a real Claude integration run against the Maratus repository. The real run must show (1) two independent Claude sessions communicating, (2) real code changes with independently executed tests, (3) independent QA verification, (4) evidence-based Chief review, (5) memory retrieval after all sessions are closed and restarted. It must not use production credentials, connect to the live Neon database, push, merge or deploy without explicit approval. It is not reported as passed until the execution evidence exists in the database and is reachable from Mission Control.
- Retries start from the latest safely integrated mission commit (mission branch head after the last successful fast-forward), never from the mission's original base commit.
- `waiting_reply` and `waiting_approval` are separate lifecycle states on `TaskRun` and `Task`, with their own events and timeouts. Suspended-session recovery and worker-slot release are verified by integration tests, not by inspection.
- Every success status in the UI links to the underlying session events, messages, git changes, check results or memory records.
- Pinned skills are materialized under `<OFFICE_WORKER_HOME>/runs/<runId>/.office` (passed to the SDK as an additional directory) and removed after the run.
- UI-authored skills are `approved` on creation; imported skills are `pending_review` until the owner approves them.
- `AgentSkill` and `AgentSubagent` rows belong to an `AgentVersion` and are immutable with it.
- `ProjectAgent` rows list a project's team; a project with no rows is unrestricted (every active, non-system agent).
- Skill frontmatter parsing supports single-line `key: value` only.
- Phase 3: delivery into a live session happens at session boundaries only (no streaming input yet); agents read new mail with `read_inbox` or at the next run.
- Phase 3: `question`, `help_request`, `handoff` and `escalation` wake idle agents through inbox runs with `maxTurns <= 8` and `maxBudgetUsd <= 0.25`.
- Phase 3: `awaitReply` suspends the run (`waiting_reply`, lease released); the reply resumes it with the SDK session id. `replyTimeoutMinutes` defaults to 60 (`OFFICE_REPLY_TIMEOUT_MINUTES`).
- Phase 3: `handoff_task` reassigns the task to the recipient.
- Phase 3: the office tools are an in-process SDK MCP server (`office`) fed by `tool.call`/`tool.result` over the worker socket; `strictMcpConfig: true` replaces the `mcp__*` disallow wildcard.
- Phase 3: `office-summarizer` is a hidden system agent (`isSystem`) on `haiku` that writes task summaries.
- Phase 3: memory has Postgres full-text search; the pgvector column is unused.
- Phase 3: deleting memory is a hard delete (no 30-day purge yet).
- Phase 3: inbox and chat runs have no task (`TaskRun.taskId` nullable; `agentId`/`projectId` on the run).
- Phase 4: a `Mission` (owner request) is planned by the Chief's `plan` run on a read-only worktree of the mission branch (never the real repository), which answers with the plan JSON (`PlanSchema`: `summary`, `risks`, `tasks[]` with `key`, `kind` code|analysis|review, `agent`, `dependsOn`, `requirements`, `acceptanceCriteria`, `requiredConsultations`, `approvalPoints`, `budgetUsd`). The plan is validated against the project's team, then waits for the owner (`plan` approval, policy default `ask`); approval creates the tasks and `TaskDependency` rows. `approvalPoints` live only in `Mission.plan` (no column).
- Phase 4: approval policy per project (`settings.approvalPolicy`): `plan`, `git_push`, `merge`, `deploy`, `destructive_command`, `sensitive_path`, `budget_exceeded`, each `ask` (default), `auto` or `block`, plus `destructivePatterns` and `sensitivePaths`. A pending approval expires after `approvalTimeoutMinutes` (default 30) and the tool call is denied; the worker denies on its own at `approvalTimeoutMinutes + 5`.
- Phase 4: tool approvals are enforced by a `PreToolUse` hook (`packages/runtime/src/gate.ts`), and gated tools are kept out of `allowedTools` when a policy or a read-only checkout applies, because the SDK auto-allows `allowedTools` before `canUseTool`. The project's approval policy applies to every run kind (mission and non-mission task, chat, inbox, plan, review); plan and review runs keep the read-only gate on top, whose Bash check allows only the read-only git list.
- Phase 4: worktrees live under `<OFFICE_WORKER_HOME>/worktrees/`, never inside the repository. The mission branch is `office/<slug>-<id6>`; a run branch is `<missionBranch>-runs/<taskSlug>-<run8>` (git cannot hold both `office/<m>` and `office/<m>/<x>`). A code run's commits are fast-forwarded onto the mission branch only after a passed `checkCommand`; a failed check integrates nothing (`none`), a non-fast-forward head is `needs_integration`. Retries start from the mission branch head.
- Phase 4: a worktree-local `prepare-commit-msg` hook adds `Office-Agent: <agent> <runId>` to every agent commit. `checkCommand` runs via `/bin/sh -lc` with a process-group kill at `checkTimeoutSeconds`; its `CheckResult` is the test evidence.
- Phase 4: the project's `envTemplate` (dummy values) is written to `envFile` in the worktree, mode 0600, excluded through `info/exclude` (git resolves it to the repository's shared `.git/info/exclude`); the real env file never enters a worktree.
- Phase 4: the Chief's `review` run decides `review → done|reopen|failed` per task through `review_task`, from `get_task_evidence`: code needs at least one committed run `fast_forwarded`, no committed run after the last fast-forwarded one unintegrated, and a passed latest check; a Chief reopen counts as an attempt, so at `attempts >= maxAttempts` `review_task` refuses `reopen` and the Chief decides `done` or `failed`; analysis needs an artifact or memory entry; review needs a `review` artifact; plus the required consultations. The owner overrides with `POST /tasks/:id/done|reopen|failed`. A mission with undecided review tasks stays `review`; the owner's last decision settles it `done` or `failed`. Tasks without a mission keep Phase 1 auto-done.
- Phase 4: budgets: `dailyBudgetUsd` is a soft per-project limit, raised by each approved daily-budget `budget_exceeded` approval that day (`dailyBudgetUsd * (1 + approved)`); `Mission.budgetUsd` is a hard cap, raised only by the owner (`PUT /missions/:id`); reaching it raises no approval. `defaultTaskBudgetUsd` caps a task run unless the plan sets `budgetUsd`.
- Phase 4: push, merge, deploy and PR creation are approval requests only; the platform never pushes. Mission cancel is atomic and idempotent and cancels live runs; tasks start only while their mission is `approved`, `running` or `review`. The greenfield path (no repository) is not built.
- Phase 5: the API is the git endpoint for workers (`/git/<projectId>`, `git http-backend` behind the worker credential as a bearer token; revoked workers are refused per request). Only fast-forwards of `refs/heads/office/*` are accepted there (`pre-receive` hook: no other refs, deletes or tags; the default branch is never writable); nothing is pushed to the project's `origin`.
- Phase 5: remote workers (`canClone`) clone into `<OFFICE_WORKER_HOME>/repos/<projectId>` from the endpoint, never receive a control-plane path (`RunSpec.git.remote`, exactly one of `repoPath`/`remote`), and integrate by pushing the mission branch with `--force-with-lease` against the run's base after an ancestry check. Runs without a worktree (chat, inbox, summary, non-mission task) are local-only; local workers are preferred.
- Phase 5: a worker is local (gets `repoPath`, may take local-only runs) only when its `hello` `machineId` equals the API's and its `allowedRoots` cover the repository. Both compute the id the same way: `/etc/machine-id` trimmed, else a random id persisted 0600 at `<OFFICE_WORKER_HOME>/machine-id` (worker) or `<OFFICE_DATA_DIR>/machine-id` (API). A worker without `machineId` is never local unless `OFFICE_TRUST_UNIDENTIFIED_WORKERS=true` (default false). `Worker.machineId` stores it; `GET /workers` shows it.
- Phase 5: resumes are pinned to the worker that holds the SDK session (`TaskRun.workerId`); with it offline at the reply timeout the run fails and the task is retried fresh. Results are persisted in the worker outbox (`<OFFICE_WORKER_HOME>/outbox/<runId>.json`, 0600) until sent or rejected with `No live lease`.
- Phase 5: worker tags are lowercase `^[a-z0-9][a-z0-9-]{0,31}$` (`OFFICE_WORKER_TAGS`); a project's `requiredWorkerTags` must all be present on a worker for mission runs (task, plan and review runs with a worktree); local-only runs (chat, inbox, summary, non-mission task) ignore them. The remote worker container (`worker-remote`, Compose profile `remote`) mounts no host path, only the named volume `office-worker-remote`; `infra/compose.hostnet.yaml` is the opt-in host-network override for hosts whose firewall blocks the Docker bridge.
- The web UI follows the Foundations artboard: tokens in `apps/web/src/app/globals.css`, every visual piece a component in `apps/web/src/components/ui` (shadcn pattern, Tailwind inside the component). Pages compose components and carry no styling of their own.

## Commands

- `pnpm infra:up` - start Postgres (5433) and Redis (6380)
- `pnpm db:migrate` - apply Prisma migrations
- `pnpm seed` - seed the `office-sandbox` project, the 12 shipped skills, the default team and the hidden `office-summarizer` agent (idempotent)
- `scripts/dev-all.sh` - export `.env`, start infra, migrate, run `pnpm dev`
- `pnpm dev` - run all packages in watch mode
- `pnpm test` - run all tests

## Docs

`README.md` (runbook), `docs/architecture.md`, `docs/worker-protocol.md`, `docs/development.md`, `docs/security.md`.

## Rule

Update `docs/progress.md` at the end of every phase and whenever a decision changes.
