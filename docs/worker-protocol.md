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
- `run.result { runId, sessionId, result }`: the final `RunResult` (`status` succeeded, failed or cancelled, `resultText`, `error`, `sdkSessionId`, `usage` with tokens, `costUsd`, turns and duration); the API finishes the run, the session and the task, and writes a `UsageRecord`.

### API to worker (`ApiToWorkerSchema`)

- `welcome { workerId, credential? }`: authentication succeeded; `credential` is present only after enrollment, and the worker saves it to `$OFFICE_WORKER_HOME/credentials.json` (mode 0600).
- `run.assign { spec }`: a leased run to execute; `RunSpec` carries run, session, agent and project ids, `cwd` (the project repository), prompt, system prompt, model, effort, allowed tools, turn and budget limits, subagent limits and an optional SDK session id to resume.
- `run.cancel { runId }`: stop the run; the worker interrupts the SDK session and reports a `cancelled` result.
- `error { message }`: the previous message was invalid or rejected (for example a `run.result` without a live lease).

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

Requires the owner's session cookie; an unauthenticated upgrade gets HTTP 401. Topics are `global`, `task:<taskId>` and `run:<runId>`.

### UI to API (`UiClientMessageSchema`)

- `subscribe { topic, afterSeq? }`: start receiving a topic; for `run:<runId>` the API first replays persisted events with `seq > afterSeq` (default 0), then switches to live delivery.
- `unsubscribe { topic }`: stop receiving a topic.

### API to UI (`UiServerMessageSchema`)

- `event { topic, event }`: one `OfficeEvent` of a run, replayed or live.
- `task.status.changed { topic, task: { id, status, updatedAt } }`: a task changed status; published to `task:<id>` and `global`.
- `run.status.changed { topic, runId, status }`: a run changed status; published to `run:<id>`.
- `replay.done { topic, lastSeq }`: replay of a `run:` topic is complete up to `lastSeq`; everything after this is live.
- `error { message }`: invalid message, unknown run (`run not found`) or a failed replay.

Replay hands over to live delivery without gaps or duplicates: live events that arrive during replay are buffered and then passed through the same `seq` filter, so a client that reconnects with the last `seq` it saw receives every later event exactly once.
