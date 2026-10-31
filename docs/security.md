# Security

This describes what Phases 1 and 2 enforce and what they do not yet. The target model is spec §14.

## Owner authentication

- One owner account (`User`). `POST /auth/setup` creates it and works only while no user exists; concurrent setups are serialized by a Postgres advisory lock, so only one owner can be created.
- Passwords are hashed with argon2.
- Login creates a `UserSession` with a random 32-byte token, sent as the `office_session` cookie: `httpOnly`, `sameSite=lax`, `secure` when `NODE_ENV=production`, valid 30 days. Logout deletes the session row.
- Every HTTP route and the UI WebSocket require a valid session, except `/health`, `/auth/setup`, `/auth/login`, `GET /auth/me` (so the UI can learn that setup is required) and `/ws/worker` (which authenticates workers itself). An unauthenticated WebSocket upgrade gets HTTP 401.
- CORS allows only `WEB_ORIGIN`, with credentials.
- No secrets are sent to the browser. Worker routes never return the enrollment token hash or the credential hash.

## Worker credential

- The owner creates a worker and receives a random 32-byte enrollment token once. Only its SHA-256 hash is stored.
- On first connection the worker trades the token for a long-lived credential. The API stores only the credential's hash and clears the token hash, so the token cannot be used twice. The worker saves the credential to `$OFFICE_WORKER_HOME/credentials.json` with mode 0600.
- A worker authenticates every connection with its credential. User sessions are never accepted on the worker endpoint, and worker credentials are never accepted on user routes.
- Revoking a worker (`DELETE /workers/:id`) marks it `revoked`, closes its socket and makes its credential useless. The match on token or credential is re-checked inside the write, so a concurrent revoke wins over a connecting worker.
- Every `run.event` and `run.result` is checked against the run's lease: a worker can only report on runs it currently holds (see `docs/worker-protocol.md`, rejection rules).

## Workspace roots

- Each worker declares allowed workspace roots (`OFFICE_WORKSPACE_ROOTS`). The scheduler only assigns a task to a worker when the project's repository path is under one of that worker's roots.
- The worker checks again before running: the run's `cwd` is resolved with symlinks followed and must be an allowed root or inside one, compared by path segment (`/a/bc` is not under `/a/b`). Otherwise the run is rejected with `cwd outside allowed roots`.
- Phase 1 runs agents directly in the project repository. Per-run git worktrees, the dummy env template and the rule that real `.env` files never enter a worktree arrive in Phase 4.

## Skills

- **Import roots.** `POST /skills/import` with `source: local` reads a directory only if its real path (symlinks resolved) is under one of `OFFICE_SKILL_IMPORT_ROOTS` (colon-separated; default `<repo>/templates/skills`); otherwise it answers `path_outside_import_roots`. Dot-directories and symlinks inside the skill directory are skipped.
- **Git import.** `source: git` accepts only `https://` URLs, plus `file://` URLs whose path is under an import root. The clone runs `git clone --depth 1` through `execFile` (no shell) with a 60 s timeout, `GIT_TERMINAL_PROMPT=0` and `GIT_ALLOW_PROTOCOL=https:file`, into a temporary directory under `OFFICE_DATA_DIR` that is removed afterwards. The optional `path` inside the clone must resolve inside the clone.
- **Review.** Imported skills start `pending_review` and cannot be pinned until the owner approves them; skills written in the UI are `approved` on creation. Every skill version is validated: `SKILL.md` with a `name` matching `^[a-z0-9][a-z0-9-]{0,63}$` and a `description`, relative paths without `..`, at most 50 files, 64 KiB per file and 512 KiB in total.
- **Untrusted text.** Skill content is treated as untrusted text: the UI renders it as text, never as HTML, and the platform never executes it. It reaches the agent only as files under the run root, which the worker validates again before writing (mode 0600) and removes after the run. A skill's instructions can still steer the agent within the agent's allowed tools; review imported skills before approving them.
- **Tool grant.** `Skill` and `Agent` are added to a run's allowed tools only when the agent version pins at least one skill (`Skill`) or defines at least one subagent (`Agent`).
- **Run roots.** Run roots live under `<OFFICE_WORKER_HOME>/runs`, outside the project repository. A starting worker deletes every directory there, so two workers must not share one `OFFICE_WORKER_HOME`, or each would sweep the other's live run roots.

## Secret redaction

- `redactSecrets` (`packages/runtime/src/redact.ts`) replaces Anthropic, GitHub, AWS and Slack key patterns, PEM private keys, and values of `*api_key*`, `*secret*`, `*token*`, `*password*` style assignments with `[REDACTED]`.
- It runs in the worker on every event before it is sent, and again in the API on every event and result before they are persisted, as a safety net against a worker that does not redact.
- Redaction is pattern-based. A secret in an unrecognized format is not caught.

## Claude permissions

- The Claude adapter runs the Agent SDK with `permissionMode: 'default'`.
- The agent version's `allowedTools` are passed as `allowedTools`; every built-in tool not in that list is passed as `disallowedTools`. A `canUseTool` callback denies any tool that is not in the allow list.
- Project settings (`settingSources: ['project']`) are loaded because project repositories are owner-controlled. Deny rules still cap the tool surface.
- `maxTurns` and `maxBudgetUsd` from the agent version are passed to the SDK. The budget is the SDK's soft limit.
- The child process gets the worker's environment without `CLAUDE*` and `AI_AGENT` keys, so it uses the machine's Claude Code login or `ANTHROPIC_API_KEY`. Office's own keys are dropped too: `DATABASE_URL*`, `COOKIE_SECRET`, `REDIS_URL` and every `OFFICE_*` key.

## Not yet enforced

- **Approvals** (Phase 4): there are no approval gates. Allowed tools, including `Bash`, `Edit` and `Write`, run without asking: listing a tool in `allowedTools` auto-approves it, so `canUseTool` is not consulted for it (the SDK logs a `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED` warning saying so). When skills or subagents are pinned, the same warning lists `Skill` and `Agent` too: they are auto-approved like the other allowed tools. Destructive commands, sensitive paths, `git push`, merge and deploy are not gated. Approval gates in `canUseTool`, a PreToolUse hook or equivalent, and `approvalTimeoutMinutes` come in Phase 4.
- **Budgets** (Phase 4): only the per-run SDK soft budget exists. The scheduler does not enforce per-agent daily budgets or hard caps.
- **Worker environment** (Phase 4): the agent's child process inherits the worker's whole environment apart from the keys above. Start the worker with only the variables it needs; any other secret in its environment (for example one added to `.env`, which `scripts/dev-all.sh` exports whole for convenience) reaches the agent. Use this only with throwaway local values.
- **Project authorization and membership** (Phase 6): there is one owner, who can see every project. `ProjectMember` and per-project authorization are not built.
- **Audit log** (Phase 6): agent edits, approvals and worker revocations are not written to an audit log yet. Agent edits are traceable through immutable `AgentVersion` rows.
- **Untrusted content**: tool output, agent text and skill content are rendered as text in the UI, never executed. Agent messages and memory (Phase 3) will be treated the same way.
