# Worker and UI protocol

Two WebSocket endpoints on the API, both carrying one JSON object per frame. Every message is validated against the Zod schemas in `packages/shared/src/protocol.ts`; a message that fails validation is answered with an `error` message.

## Worker connection: `/ws/worker`

The worker connects outbound. The endpoint is not behind the owner's cookie; the worker authenticates with its first message. The first message must be `hello`. Anything else gets `error` and the socket is closed with code 4400; an invalid or unauthenticated `hello` gets `error` and code 4401. A second connection for the same worker replaces the first, which is closed with code 4409. Revoking a worker closes its socket with code 4403.

Messages on one socket are handled strictly in order.

### Worker to API (`WorkerToApiSchema`)

- `hello { enrollToken? | credential?, name, capacity, allowedRoots, activeRunIds }`: authenticates the worker, either with a one-time enrollment token (first start) or with its saved credential, and reports its capacity, allowed workspace roots and the runs still executing locally.
- `heartbeat { capacity, activeRunIds }`: sent every 10 s; updates `lastHeartbeatAt` and capacity and renews the leases of the listed runs.
- `run.accepted { runId }`: the worker has started the assigned run; the run moves `queued → running` and the task moves to `running`.
- `run.rejected { runId, reason }`: the worker refuses the run (for example `cwd outside allowed roots`); the API logs it, and the run keeps its lease until it expires and the task is retried.
- `run.event { event }`: one normalized `OfficeEvent` (`type`, `seq`, `ts`, `sessionId`, `runId`, `agentId`, `projectId`, `payload`), redacted by the worker; the API redacts it again, persists it as a `SessionEvent` and publishes it to `run:<runId>` subscribers.
- `run.result { runId, sessionId, result }`: the final `RunResult` (Phase 4 adds `structuredOutput` for plan and review runs; `git { branch, baseCommit, headCommit, commits[], diffStat, filesChanged, integration: none|fast_forwarded|needs_integration, worktreePath? }` for runs with a worktree; `check { command, status: passed|failed|timeout|skipped, exitCode, durationMs, output }` for code runs, output capped at 200 000 characters). The API stores `GitWorkspace` and `CheckResult` rows, the check output as an `Artifact`, and appends `agent.check.completed { checkResultId, command, status, exitCode, durationMs, artifactId }` to the run's events itself. The base fields are `status` (succeeded, failed, cancelled or suspended), `resultText`, `error`, `sdkSessionId` and `usage` (tokens, `costUsd`, turns and duration). The API finishes the run, the session and the task, and writes a `UsageRecord`. `suspended` (Phase 3) means the agent called an office tool with `awaitReply` and the adapter interrupted the session; `sdkSessionId` is required with it. The API then moves the run, session and task to `waiting_reply` and releases the lease instead of finishing the run.
- `tool.call { runId, sessionId, callId, name, args }` (Phase 3): the agent called office tool `name` through the in-process MCP server. The API checks that this worker holds a live lease on the run and that `sessionId` is the run's session, executes the tool with the agent and project of that session, and answers with `tool.result` carrying the same `callId`. A tool outside the run kind's set (`submit_summary` only for `summary` runs, every other tool for `task`, `inbox` and `chat` runs) is answered `unknown_tool`.

- `approval.request { runId, sessionId, request: { requestId, toolName, input, type, reason } }` (Phase 4): the gate stopped a tool call that the project's approval policy marks `ask`. The API stores an `Approval` row (`pending`, `expiresAt` = now + `approvalTimeoutMinutes`), moves the run, session and task to `waiting_approval` (the lease stays live, the session keeps running and waits), and publishes `approval.changed`. A task-scoped approval that already matches the call, or a repeated `requestId` already decided, is answered at once with `approval.result`. A request for a run this worker holds no live lease on is answered `approval.result deny`, not `error`. Requests the worker could not send are buffered and sent after reconnect.

### API to worker (`ApiToWorkerSchema`)

- `welcome { workerId, credential? }`: authentication succeeded; `credential` is present only after enrollment, and the worker saves it to `$OFFICE_WORKER_HOME/credentials.json` (mode 0600).
- `run.assign { spec }`: a leased run to execute; `RunSpec` carries run, session, agent and project ids, `cwd` (the project repository), prompt, system prompt (with the skills section appended when skills are pinned), model, effort, allowed tools, turn and budget limits, subagent limits, an optional SDK session id to resume, and:
  - `skills`: the agent version's pinned skills, each with `name`, `version`, `checksum`, `mode` (`eager` or `on_demand`) and `files` (relative path to content). The worker validates them and writes them to `<OFFICE_WORKER_HOME>/runs/<runId>/.office/.claude/skills/<name>/`, then removes the run root after the run.
  - `subagents`: the version's native subagents (`name`, `description`, `prompt`, optional `tools`, `model`, `maxTurns`, and the pinned `skills` each may use), passed to the SDK as `agents`.
  - `skillsDir`: filled in by the worker, never by the API: the `<runRoot>/.office` directory it materialized, passed to the SDK as `additionalDirectories`.
  - `kind` (Phase 3): `task`, `inbox`, `chat` or `summary` (default `task`).
  - `tools` (Phase 3): the office tool names the adapter serves for this run (from `toolsForKind`).
  - `startSeq` (Phase 3): the last `seq` already stored for the session; a resumed run numbers its events from `startSeq + 1`. It is 0 for a new run.
  - `resumeSdkSessionId`: set when a `waiting_reply` run resumes, and for a `chat` run that continues its conversation's session.
  - Phase 4 mission fields: `git { repoPath, defaultBranch, missionBranch, taskSlug, committerName, committerEmail, agentName }` (the worker creates a worktree under `<OFFICE_WORKER_HOME>/worktrees/<runId>` on the run branch `<missionBranch>-runs/<taskSlug>-<run8>` from the mission branch head, and installs the `Office-Agent:` trailer hook), `readOnlyCheckout` (plan, review and analysis runs: the gate blocks `Edit`, `Write`, `MultiEdit`, `NotebookEdit` and Bash commands that look like writes or call git outside the read-only git list, and no commit is expected), `setupCommand`, `checkCommand` and `checkTimeoutSeconds` (default 900), `env { file, vars }` (the project's dummy `envTemplate`, written to `file` in the worktree with mode 0600 and listed in the repository's shared `.git/info/exclude`), `approvalPolicy` and `approvalTimeoutMinutes` (default 30; since Task 12b set on every run kind, not only mission runs), `outputFormat { type: 'json_schema', schema }` (plan and review runs answer with structured output), and `taskKind`. Plan runs (since Task 12c) and review runs carry a `git` block with `readOnlyCheckout`: they run on a read-only worktree of the mission branch (`taskSlug` `plan` or `review`), which the worker creates from the default branch when it does not exist yet. When the worker removes a finished worktree it also deletes the run branch if the mission branch contains it (fast-forwarded or no commits); a `needs_integration` branch is kept.
- `run.cancel { runId }`: stop the run; the worker interrupts the SDK session and reports a `cancelled` result.
- `tool.result { callId, result }` (Phase 3): the answer to a `tool.call`. `result` is `{ ok: true, result, suspend? }` or `{ ok: false, code, error }`. Codes include `unknown_tool`, `invalid_args`, `not_found`, `limit_exceeded`, `no_lease` and `internal_error`. `suspend: true` tells the adapter to end the session after this result (the call had `awaitReply`).
- `approval.result { runId, decision: { requestId, decision: allow|deny, message? } }` (Phase 4): the owner's decision, a task-scoped match, or the timeout deny. Before sending, the API moves a run whose requests are all decided back to `running`, and records `Approval.deliveredAt` once the worker has it; undelivered decisions are re-sent on the worker's next `hello`. The worker ignores decisions for unknown or already resolved `requestId`s, and denies on its own `approvalTimeoutMinutes + 5` minutes after a request (backstop). The worker reads `approvalTimeoutMinutes` from the run spec at run start; the API reads it from the project settings when the request arrives (`expiresAt`), so a settings change during a run moves only the API's expiry.
- `error { message }`: the previous message was invalid or rejected (for example a `run.result` without a live lease).

### Office tool calls (Phase 3)

The worker's `ToolBridge` gives every office tool call a `callId` and sends `tool.call`. It waits at most 30 s for the `tool.result`; after that the call fails with code `timeout`. A call made while the socket is down fails at once, and calls still pending when the socket closes fail with code `disconnected`. Tool calls are not buffered across a reconnect.

After a successful call the worker records a derived event in the run's event stream:

- `send_message`, `request_help`, `handoff_task`, `escalate_to_chief` and `reply_message`: `agent.message.sent { messageId, conversationId, to?, type }`.
- `read_inbox`: `agent.message.received { count }`.
- `propose_memory`: `memory.proposed { entryId }`.

Phase 4 events: the gate emits `agent.waiting_approval { requestId, toolName, input, type, reason }` before it asks and `agent.approval.resolved { requestId, decision, message? }` after; the API emits `agent.check.completed` (above).

The adapter emits `agent.waiting_reply { messageId, to }` when a call with `awaitReply` suspends the run. The API records `agent.resumed { reason, messageId? }` itself when it resumes the run. The worker skips skill materialization for `summary` runs.

### Enrollment

The owner creates a worker (`POST /workers`), which stores only the SHA-256 hash of a random enrollment token and shows the token once. The worker sends it in `hello`; the API matches a `pending` worker with that hash, generates a long-lived credential, stores its hash, clears the enrollment token hash, marks the worker `online` and returns the credential in `welcome`. Later connections send `hello` with the credential; a `revoked` worker cannot authenticate.

### Lease rules

- A run is created `queued` with a lease of 60 s (`OFFICE_LEASE_SECONDS`) on one worker.
- Each `heartbeat` (every 10 s, `OFFICE_HEARTBEAT_SECONDS`) renews the lease of every run it lists that is still `queued` or `running` on that worker, to 60 s from now.
- A disconnected worker is marked `offline`, but its runs keep their leases. The scheduler marks a run whose lease has expired as `lost`, appends a `run.lease.lost` event, and returns the task to `ready` while attempts remain (`maxAttempts`, default 2), otherwise `failed`.
- Reattach on `hello`: a reconnecting worker lists its still-executing runs in `activeRunIds`, and the API renews their leases instead of killing them. Results the worker could not send before the disconnect stay in `activeRunIds` until they are delivered.
- The worker's free capacity is computed from the runs the database says it holds, not from the worker's own report.

### Rejection rules

1. **No live lease, no effect.** A `run.event` or `run.result` for a run that this worker does not hold with a live lease (expired, lost, reassigned after reconnect, or owned by another worker) is rejected and does not change run or task state. An event is dropped and logged; a result is answered with `error` (`No live lease for run <id> on this worker`). The lease is checked again inside the transaction that writes the result, so a lease that expires between the check and the write still loses.
2. **Duplicate events are idempotent.** An event whose `(sessionId, seq)` is already persisted (a worker re-sending after reconnect) is stored once; the duplicate is ignored silently, not published again, and no error reaches the worker.

A `run.result` for a run still `queued` (its `run.accepted` was lost) is accepted implicitly, provided the lease is live, so a finished result is not lost.

## UI connection: `/ws/ui`

Requires the owner's session cookie; an unauthenticated upgrade gets HTTP 401. Topics are `global`, `task:<taskId>`, `run:<runId>`, `conversation:<conversationId>` (Phase 3) and `mission:<missionId>` (Phase 4).

### UI to API (`UiClientMessageSchema`)

- `subscribe { topic, afterSeq? }`: start receiving a topic; for `run:<runId>` the API first replays persisted events with `seq > afterSeq` (default 0), then switches to live delivery.
- `unsubscribe { topic }`: stop receiving a topic.

### API to UI (`UiServerMessageSchema`)

- `event { topic, event }`: one `OfficeEvent` of a run, replayed or live.
- `task.status.changed { topic, task: { id, status, updatedAt } }`: a task changed status; published to `task:<id>` and `global`.
- `run.status.changed { topic, runId, status }`: a run changed status; published to `run:<id>`.
- `message.created { topic, message }` (Phase 3): a message was stored; published to `conversation:<id>` and `global`. `message` is the same view `GET /conversations/:id` returns.
- `memory.changed { topic: global, entryId, status }` (Phase 3): a memory entry was created, verified, rejected, edited or deleted.
- `approval.changed { topic, approval }` (Phase 4): an approval was created, decided or expired; published to `mission:<id>`, `run:<id>` and `global`. `approval` is the `ApprovalView` of `GET /approvals/:id`.
- `mission.status.changed { topic, mission: { id, status, updatedAt } }` (Phase 4): published to `mission:<id>` and `global`.
- `replay.done { topic, lastSeq }`: replay of a `run:` topic is complete up to `lastSeq`; everything after this is live.
- `error { message }`: invalid message, unknown run (`run not found`) or a failed replay.

Replay hands over to live delivery without gaps or duplicates: live events that arrive during replay are buffered and then passed through the same `seq` filter, so a client that reconnects with the last `seq` it saw receives every later event exactly once.
