# Claude Agent Office

A control plane that turns Claude Code sessions into a persistent AI software team.

- Spec: `docs/superpowers/specs/2026-10-31-agent-office-design.md`
- Plan: `docs/superpowers/plans/2026-10-31-phase1-foundation.md`
- Progress: `docs/progress.md`
- Standing decisions: `docs/decisions.md`. Every decision taken so far lives there, not here. Before changing an area, find its decisions (`graphify query "<area>"`, or search the file) and keep them or change them on purpose.

## Rules that hold everywhere

- Quality first, small steps (owner, 2026-11-10): add only what real use asks for; one request is one small change with its test.
- pnpm workspaces monorepo; the test Postgres is on host port 5433.
- Single owner; no multi-user features.
- The platform never pushes. Push, merge and deploy are approval requests only; the one local exception is `integrateWhenDone`.
- A real `.env.local` never enters a worktree.
- Statuses come from records only: no agent text drives a status chip, and every success status in the UI links to its evidence.
- Web UI: tokens in `apps/web/src/app/globals.css`, every visual piece a component in `apps/web/src/components/ui`; pages compose components and carry no styling of their own. Confirmations use `useConfirm`, never `window.confirm`.
- Prisma queries run only when awaited: never `void prisma.x()`.
- API and worker are upgraded together.
- Office ships no skills; agents use the owner's Claude-installed skills.

## Commands

- `pnpm infra:up` - start Postgres (5433) and Redis (6380)
- `pnpm db:migrate` - apply Prisma migrations
- `pnpm seed` - seed the `office-sandbox` project, the default team and the hidden `office-summarizer` agent (idempotent)
- `scripts/dev-all.sh` - export `.env`, start infra, migrate, run `pnpm dev`
- `pnpm dev` - run all packages in watch mode
- `pnpm test` - run all tests

## Docs

`README.md` (runbook), `docs/decisions.md`, `docs/architecture.md`, `docs/worker-protocol.md`, `docs/development.md`, `docs/security.md`.

## Rule

Update `docs/progress.md` at the end of every phase and whenever a decision changes, and write the decision itself into `docs/decisions.md`.
