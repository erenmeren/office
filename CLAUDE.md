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

## Commands

- `pnpm infra:up` - start Postgres (5433) and Redis (6380)
- `pnpm db:migrate` - apply Prisma migrations
- `pnpm dev` - run all packages in watch mode
- `pnpm test` - run all tests

## Rule

Update `docs/progress.md` at the end of every phase and whenever a decision changes.
