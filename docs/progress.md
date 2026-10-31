# Progress

| Phase | Status |
|-------|--------|
| 1 | done |
| 2 | not started |
| 3 | not started |
| 4 | not started |
| 5 | not started |
| 6 | not started |

## Outstanding

Phase 1:
- Acceptance criterion met in the Write-requested run: with the description asking for the Write tool, the run produced `agent.tool.started` for `Write` and `agent.file.changed` for `hello.txt` (see "Task 10 real Claude acceptance run (Write tool requested)" below). With the original wording the model created the file with a single `Bash` command in all three attempts (see "Task 10 real Claude acceptance run").
- Visual browser click-through of the acceptance flow (login, submit the task in the UI, watch the live log, reload after an API restart) was not performed by the implementer, who had no browser. The flow was driven through the HTTP API and the UI WebSocket instead, and the web pages answered HTTP 200. It remains for the owner.
- The dashboard and workers pages do not poll or subscribe for updates; they show fresh data only on reload (Task 9).
- The agent's child process inherits the worker's environment except `CLAUDE*`, `AI_AGENT`, `DATABASE_URL*`, `COOKIE_SECRET`, `REDIS_URL` and `OFFICE_*` keys; any other secret exported into the worker reaches the agent (see `docs/security.md`).

Phase 2 (agents and skills): skill registry and versions, skill materialization, native subagents, Agent Studio (agent editing in the UI).

Phase 3 (messaging and memory): message bus and inbox runs, agent MCP tools, human chat as a real session, task summaries, project memory, context pack, memory UI.

Phase 4 (Chief and orchestration): per-run git worktrees and the mission branch, dummy env template, platform-side `checkCommand`, approvals (`canUseTool` gates, `approvalTimeoutMinutes`), scheduler budgets, `waiting_reply` / `waiting_approval` lifecycle, Chief planning and evidence-based review (Phase 1 auto-moves `review` to `done`), required consultations, Mission Control.

Phase 5 (hybrid workers): remote workers, remote clone, worker capabilities.

Phase 6 (observability and hardening): Agent Inspector, cost views, audit log, project membership, interactive PTY shell.

## Phase 1 evidence

### Task 4 runtime smoke (real Claude)

Date: 2026-10-31. Command: `pnpm --filter @office/runtime exec tsx scripts/smoke-claude.ts` (model `haiku`, `maxBudgetUsd` 0.05, prompt `Reply with exactly: RUNTIME_OK`). Result: events `agent.started`, `agent.text`, `agent.completed`; status `succeeded`; resultText `RUNTIME_OK`; costUsd 0.0034266.

```
event agent.started
event agent.text
event agent.completed
result {
  "status": "succeeded",
  "resultText": "RUNTIME_OK",
  "sdkSessionId": "0fca8b01-e234-44aa-a900-37f40277886c",
  "usage": {
    "inputTokens": 2,
    "outputTokens": 11,
    "costUsd": 0.0034266,
    "numTurns": 1,
    "durationMs": 1965
  }
}
```

Re-run after review fixes (`disallowedTools` added), same date: status `succeeded`, resultText `RUNTIME_OK`, costUsd 0.0034575, same three events.

### Task 10 real Claude acceptance run

Date: 2026-10-31. Result: **partial**. The run succeeded end to end, but the criterion "at least one `agent.tool.started` for `Write` with `agent.file.changed`" was not met: the model chose `Bash` to create the file in all three attempts (one run plus the two allowed retries). No platform error occurred.

Setup: `pnpm infra:up`, `pnpm seed` (project `office-sandbox` `e844090c-2a16-4a62-a199-a251103a8736`, repository `/home/meren/projects/office-workspaces/office-sandbox`; agent `developer` `15e9d1b8-65b4-4350-96ca-067db9315e9d`, version 1, model `sonnet`, `maxBudgetUsd` 1). API (`pnpm --filter @office/api dev`), worker (`OFFICE_RUNTIME=claude`, enrolled once with an enrollment token from `POST /workers`, worker `e973b79e-8611-4552-b949-b291d5fd493e`, credential saved to `~/.office-worker/credentials.json`) and web (`pnpm --filter @office/web dev`) were started with the root `.env` exported. The worker used the machine's Claude Code login.

Driver: the implementer had no browser, so the task was submitted with `POST /tasks` (cookie session of the owner account), and the live log was read over `/ws/ui` with `{"type":"subscribe","topic":"run:<runId>","afterSeq":0}`, the same messages the task page uses. `GET /`, `GET /login` and `GET /tasks/c0e0e558-d8a3-4fe9-a79e-b5905f7aecd5` on the web app returned HTTP 200.

Task: title `Create hello.txt`, description `Create a file named hello.txt in the current directory containing the single line "Hello from Agent Office", then show its contents with cat.`

| Attempt | Task | Run | Session | SDK session | Events | Cost (USD) | Task status |
|---|---|---|---|---|---|---|---|
| 1 | `c0e0e558-d8a3-4fe9-a79e-b5905f7aecd5` | `1b4f13e6-1f0b-4663-95c1-87b6da7e1c7c` | `1746f603-8803-4dbe-8af8-8680cab1313a` | `6fcedd53-de1e-46f7-a6ac-2008f13cb98e` | 6 | 0.1079112 | done |
| 2 | `49a8a425-93fc-4004-b45d-d76b6b49234a` | `e967bc80-d477-44b0-897b-99f056155c2d` | `f9b0feb4-b304-46eb-97f3-52c5e476e2b8` | `fa29be03-0c2a-4bb6-a857-8ab90b9e571a` | 6 | 0.0262102 | done |
| 3 | `dd04c924-883c-4eaf-8436-d047412601d0` | `f7072bcd-3fcc-44b4-9841-14b0a37fa5f2` | `89c94db5-1da1-4059-817f-e7fa8c5582d3` | `e99b176e-2157-41ca-91aa-8f15e3b86939` | 6 | 0.0263482 | done |

Total cost 0.1604696 USD. `hello.txt` was removed before attempts 2 and 3 so that each attempt had to create it.

Attempt 1 events as received live over `/ws/ui` (run started 2026-10-31T15:52:43.609Z, finished 15:52:51.117Z):

```
seq 1 agent.started           2026-10-31T15:52:44.205Z  model claude-sonnet-5-5
seq 2 agent.tool.started      2026-10-31T15:52:49.029Z  tool Bash: ls hello.txt 2>&1; printf 'Hello from Agent Office\n' > hello.txt && cat hello.txt
seq 3 agent.command.executed  2026-10-31T15:52:49.030Z  same command
seq 4 agent.tool.completed    2026-10-31T15:52:49.078Z  "ls: cannot access 'hello.txt': No such file or directory\nHello from Agent Office"
seq 5 agent.text              2026-10-31T15:52:50.573Z
seq 6 agent.completed         2026-10-31T15:52:50.587Z  costUsd 0.10791119999999998, numTurns 2, durationMs 6688
run.status.changed succeeded; GET /tasks/<id>: status done, attempts 1
```

Attempts 2 and 3 produced the same six event types in the same order (attempt 2 used `git status --short && echo "Hello from Agent Office" > hello.txt && cat hello.txt`).

File on disk after attempt 3: `/home/meren/projects/office-workspaces/office-sandbox/hello.txt`, 24 bytes, content `Hello from Agent Office` plus a newline, sha256 `ec3c94d325c2638a2448fb45ceb38bab0083cf8399ebc8ca6aaccfb3e7762ad2` (the same hash after attempt 1).

Replay after restart: the API process was killed (health check failed), restarted at 2026-10-31T15:54:30Z, and each of the three runs was re-subscribed over `/ws/ui` with `afterSeq: 0`. Each replayed seqs 1 to 6 (`agent.started`, `agent.tool.started`, `agent.command.executed`, `agent.tool.completed`, `agent.text`, `agent.completed`) from the database, followed by `replay.done` with `lastSeq` 6. `GET /tasks/c0e0e558-d8a3-4fe9-a79e-b5905f7aecd5` still returned status `done` with the succeeded run, cost and result text. The worker reconnected by itself after the restart and was `online`.

Worker log note: the SDK printed `[CLAUDE_SDK_CAN_USE_TOOL_SHADOWED] Warning: canUseTool will not be invoked for: Read, Glob, Grep, Bash, Edit, Write. Bare allowedTools entries auto-approve the whole tool before the callback is consulted.` This is expected in Phase 1 (no approvals) and is recorded in `docs/security.md` for Phase 4.

### Task 10 real Claude acceptance run (Write tool requested)

Date: 2026-10-31. Result: **passed**. One attempt, no retry. Same project `office-sandbox`, agent `developer` (version 1, `sonnet`), worker `e973b79e-8611-4552-b949-b291d5fd493e` started with `OFFICE_RUNTIME=claude` and its saved credential. `hello.txt` was deleted before the run so the Write was a real creation. Driven through `POST /tasks` and `/ws/ui` as in the run above.

Task: title `Create hello.txt`, description `Create a file named hello.txt in the current directory containing the single line "Hello from Agent Office", then show its contents with cat. Use the Write tool to create the file, not a shell redirect.`

Task `dc7e7d65-76af-42c9-88d6-be9703002aa8`, run `0d4988f2-13bf-47cd-a131-883a73061bb4`, session `1b99b47d-79b8-46e1-8289-38fc1431a2e4`, SDK session `01b315ce-df57-4721-85cf-81a147b50eb7`. Run started 2026-10-31T16:11:48.921Z, finished 16:11:54.927Z, status `succeeded`; task `done`, attempts 1. Cost 0.0421047 USD.

Events, all received live over `/ws/ui`:

```
seq 1 agent.started           2026-10-31T16:11:49.267Z  model claude-sonnet-5-5
seq 2 agent.tool.started      2026-10-31T16:11:51.483Z  tool Write, file_path /home/meren/projects/office-workspaces/office-sandbox/hello.txt, content "Hello from Agent Office\n"
seq 3 agent.file.changed      2026-10-31T16:11:51.483Z  path /home/meren/projects/office-workspaces/office-sandbox/hello.txt
seq 4 agent.tool.completed    2026-10-31T16:11:51.506Z  "File created successfully at: .../hello.txt"
seq 5 agent.tool.started      2026-10-31T16:11:52.816Z  tool Bash: cat /home/meren/projects/office-workspaces/office-sandbox/hello.txt
seq 6 agent.command.executed  2026-10-31T16:11:52.816Z  cat /home/meren/projects/office-workspaces/office-sandbox/hello.txt
seq 7 agent.tool.completed    2026-10-31T16:11:52.858Z  "Hello from Agent Office"
seq 8 agent.text              2026-10-31T16:11:54.239Z
seq 9 agent.completed         2026-10-31T16:11:54.257Z  costUsd 0.0421047, numTurns 3, durationMs 5007
run.status.changed succeeded
```

File on disk: `/home/meren/projects/office-workspaces/office-sandbox/hello.txt`, 24 bytes, `Hello from Agent Office` plus a newline, sha256 `ec3c94d325c2638a2448fb45ceb38bab0083cf8399ebc8ca6aaccfb3e7762ad2`.

Replay after restart: the API was killed (health check failed) and restarted at 2026-10-31T16:12:11Z; re-subscribing to `run:0d4988f2-13bf-47cd-a131-883a73061bb4` with `afterSeq: 0` replayed seqs 1 to 9 with the same event types from the database, then `replay.done` with `lastSeq` 9. `GET /tasks/dc7e7d65-76af-42c9-88d6-be9703002aa8` returned `done` with the succeeded run and its cost; the web task page returned HTTP 200.
