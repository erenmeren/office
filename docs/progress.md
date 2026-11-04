# Progress

| Phase | Status |
|-------|--------|
| 1 | done |
| 2 | done |
| 3 | done |
| 4 | done (real-Claude acceptance on Maratus plus the Task 12b gate probe; see "Phase 4 evidence") |
| 5 | done (two workers: real Claude on the host, a fake-runtime container cloning over the git endpoint; see "Phase 5 evidence") |
| 6 | done (expectation 3 passed on its Task 10b re-run; see "Phase 6 evidence") |

## Outstanding

Phase 1:
- Acceptance criterion met in the Write-requested run: with the description asking for the Write tool, the run produced `agent.tool.started` for `Write` and `agent.file.changed` for `hello.txt` (see "Task 10 real Claude acceptance run (Write tool requested)" below). With the original wording the model created the file with a single `Bash` command in all three attempts (see "Task 10 real Claude acceptance run").
- Visual browser click-through of the acceptance flow (login, submit the task in the UI, watch the live log, reload after an API restart) was not performed by the implementer, who had no browser. The flow was driven through the HTTP API and the UI WebSocket instead, and the web pages answered HTTP 200. It remains for the owner.
- The dashboard and workers pages do not poll or subscribe for updates; they show fresh data only on reload (Task 9).
- The agent's child process inherits the worker's environment except `CLAUDE*`, `AI_AGENT`, `DATABASE_URL*`, `COOKIE_SECRET`, `REDIS_URL` and `OFFICE_*` keys; any other secret exported into the worker reaches the agent (see `docs/security.md`).

Phase 2:
- Visual browser click-through of the Phase 2 acceptance flow (Agent Studio pinning, the task page's Subagents card, snapshot chips and skill events) was not performed by the implementer, who had no browser. The flow was driven through the HTTP API instead, and the web pages answered HTTP 200 (see "Phase 2 acceptance (real Claude)" below). It remains for the owner.
- `ProjectAgent` (which agents belong to which project) is deferred to Phase 4; the Chief's planning needs it, nothing in Phase 2 does.
- Approvals (Phase 4): pinning skills or subagents adds `Skill` (skills) or `Agent` and `Task` (subagents) to the allowed tools, which the SDK auto-approves before `canUseTool` (see `docs/security.md`).
- Skill frontmatter parsing supports single-line `key: value` only; multi-line (folded or block) values are not supported.
- The adapter's `RunResult.usage` keeps only the last SDK result. That is the full run cost: the SDK's `SDKResultMessage.total_cost_usd` is cumulative (each result carries the running total so far), so a run with two completions, as in the subagent smoke, is not under-reported.
- In the subagent smoke, a second `agent.started` in the same run listed 106 `mcp__claude_ai_*` connector tools (Gmail, Notion, Claude Docs) from the machine's claude.ai login. `canUseTool` denied them, but a project allow rule or a skill's `allowed-tools` frontmatter could have auto-allowed them first. Fixed in Phase 2 by passing `mcp__*` in `disallowedTools`. Phase 3 replaced that wildcard (it would also block the office tools): the adapter now passes `strictMcpConfig: true`, so the session gets only the in-process `office` MCP server and no MCP server from the machine's login or settings. The Phase 3 acceptance runs' `agent.started` tool lists held no `mcp__claude_ai_*` tool.
- In the acceptance runs the designer session had no subagent tool: the adapter granted `Agent` but left `Task` in `disallowedTools`, and the SDK lists the subagent tool as `Task` in the session's tools, so it was removed. Fixed after the acceptance (both `Agent` and `Task` are granted when subagents are pinned) and checked by the runtime subagent smoke below (exit 0: the subagent was spawned and returned `SUBAGENT_OK`). A platform run with a subagent (a `SubagentRun` row from a real session) has not been done yet.

Web UI (between Phase 2 and Phase 3, 2026-11-01): the web app follows the "Claude Agent Office — Web UI" design (Foundations and Mission Control artboards). Design tokens (colors, fonts, the `glass` and `aurora` utilities) live in `apps/web/src/app/globals.css`; every visual piece is a component under `apps/web/src/components/ui` in the shadcn pattern (`cva` variants, `cn`, `data-slot`), so a redesign changes tokens and components, not pages. New: `AppShell` (sidebar, header), `StatusPill`/`StatusDot`, `AgentAvatar`, `Progress`, `PageHeader`, `Kv`, `TaskNode`, `PlanGraph` (layered layout in `src/lib/plan-layout.ts`, tested), `ChiefComposer` (creates a task for the agent with slug `chief`), `TaskDetail`, and the `/mission-control` page. Not built, because their data arrives later: the approval card and the "send an instruction" box (Phase 3/4 messaging and approvals), plan versions and dependency edges (Phase 4 Chief planning; `PlanGraph` already draws `dependsOn` arrows), the budget-today bar in the header. Fonts (Bricolage Grotesque, Instrument Sans, JetBrains Mono; SIL OFL) are self-hosted variable woff2 files under `apps/web/src/app/fonts` via `next/font/local`; the UI makes no request outside localhost. A Playwright suite (`apps/web/e2e`) renders every page and fails on any console error or warning, any external request, or a broken Mission Control interaction; `/auth/me` answers 200 `{ setupRequired: false, anonymous: true }` when logged out so the login page produces no 401 in the console.

Phase 3 (messaging and memory):
- Acceptance attempt 2 did not rewrite `docs/db-decision.md` because the file was left in the sandbox from attempt 1 (see "Verdict" under "Phase 3 evidence"). The owner may re-run the acceptance on a clean sandbox.
- Fixed: `ClaudeAdapter` did not emit `agent.waiting_reply` in attempt 1; bd3d78a adds it, and attempt 2 recorded it (seq 14).
- Fixed: the Playwright test "owner messages an agent" failed after attempt 1, because a thread switch cleared the composer after the test filled it. The test now waits for the `You and <agent>` thread heading before filling. The suite passes 8 of 8.
- Delivery into a live session (streaming input) is not built. Messages reach a live session only through `read_inbox` or at the next run boundary.
- Memory purge: deleting a memory entry is a hard delete; there is no soft delete and no 30-day purge.
- Semantic search: memory search is Postgres full-text search only; the `pgvector` column exists and is unused.
- Settings UI for the message limits, the reply timeout and the context pack size: they are environment variables only (`OFFICE_MSG_PER_SESSION`, `OFFICE_MSG_PER_TASK`, `OFFICE_ESCALATION_DEPTH`, `OFFICE_HANDOFF_CHAIN`, `OFFICE_REPLY_TIMEOUT_MINUTES`, `OFFICE_CONTEXT_PACK_MAX_CHARS`).
- No `MemoryRevision` table: a revision is a new `MemoryEntry` row that supersedes the previous one (`supersededById`).
- `agent.message.received` is emitted only when an agent reads its inbox; messages read by the owner in the UI produce no event.
- Wake retries: at most two wake runs per unread wake delivery, and a wake run that was never delivered to a worker (abandoned before `run.accepted`) also counts against the two.
- The scheduler logs "no summarizer" once per process; the warning does not reset when a summarizer appears and disappears again.
- The context pack of inbox and chat runs uses the fixed wake prompt as its full-text search text, so its "Relevant memory" section is not tailored to the mail.
- UI searches (Conversations, Project Memory) have no debounce; every keystroke sends a request.
- The "Read HH:MM" line in a thread shows the send time; the API does not expose `acknowledgedAt` yet.
- A reply consumed by resuming a waiting run is not acknowledged, so it still counts as unread in the recipient's context pack (`inboxCount` 4 and then 5 for `developer` in the acceptance).
- The pack header says entries are "facts verified by the owner", but task summaries from `office-summarizer` are stored `verified` without an owner action.
- Fixed: the sidebar's team list showed the hidden `office-summarizer` agent (`isSystem`). `GET /agents` now lists only non-system agents (`GET /agents/:id` still returns it), and `POST /tasks` answers 400 `invalid_agent` for a system or inactive agent.
- Fixed in Phase 4: `@office/db` exports `seed`, and `apps/worker/test/e2e-phase3.test.ts` imports it from there. Also fixed in Phase 4: the scheduler resumes `waiting_reply` runs before it assigns ready tasks, so a resumed run is not starved by new work.
- Fixed in Phase 4 (Task 12b): chat runs, like every other run kind, now carry the project's approval policy. They still keep the agent version's full tool surface in the project repository (no worktree confinement; see Phase 4 below).
- The Playwright memory test no longer touches proposed entries. It opens the review filter and checks that `Needs review` entries are listed, but it never clicks `Verify`. It verifies only the entry it creates.
- Data note for the owner: the dev database holds two agent proposals from acceptance attempt 1, `32f129b5` (decision) and `b244a807` (known issue). They are `verified` only because the earlier Playwright memory test verified them (07:25:25Z and 07:23:53Z); no person reviewed them. Re-check or reject them in Project Memory. The suite's `E2E decision` rows ("Use Postgres for everything.") are verified too and reach agents' context packs; delete them if they are not wanted.
- Fixed: "Verified by you" label: system-authored entries (task summaries from `office-summarizer`) now show "Verified by the system" in the Project Memory detail pane.
- Data note for the owner: before the `phase3_stamp_history` migration, the dev database's 6 pre-Phase 3 task runs (created 2026-10-31) already had `summarizedAt` set, all at 2026-11-01 06:30:44Z, and no `task_summary` entry exists for any of them (the dev project holds 4 task summaries, all for acceptance runs). The migration therefore changed nothing on the dev database.

Phase 4 (Chief and orchestration):
- Greenfield path (spec §2 secondary path): built 2026-11-02. `POST /projects` without `repoPath` creates the repository at `<OFFICE_DATA_DIR>/repos/<slug>` (`git init -b <defaultBranch>` plus one empty commit); the Chief then plans on it like any other repository. The local worker's `OFFICE_WORKSPACE_ROOTS` must cover `<OFFICE_DATA_DIR>/repos`.
- No run is confined to its worktree: an agent can `cd` out or use absolute paths and read or run anything the worker user can (seen in the Maratus run: `find / -name check.txt`, the run root). Deferred to the sandbox work in Phase 6. Since Task 12c the Chief's plan run, like its review runs, works on a read-only worktree of the mission branch, so the real repository's untracked `.env.local` is not in its checkout; `Read`, `Grep` (`path`, `glob`) and the file tools are checked against `sensitivePaths`.
- Approval detection is substring matching (`git  push` with two spaces or `git -C x push` are missed; `echo "git push"` is caught); sensitive paths match the base name case-sensitively. The read-only Bash heuristic (destructive patterns, ` > `, `>>`, `tee `, and the read-only git list) is defence in depth and still evadable (for example through a script file, `eval` or `sh -c` with a non-git writer); a Bash call without `command` skips it. An allowed git read can write a file with `--output=<file>` (`git diff --output=x`); not caught.
- Agent commits bypass the project's own git hooks (husky and similar): the trailer hook sets a worktree-local `core.hooksPath`, which also turns on `extensions.worktreeConfig` in the repository's shared `.git/config` (seen in the Maratus run).
- `setupCommand` and `checkCommand` run through `/bin/sh -lc`, which re-sources the worker user's login profile. A check grandchild that leaves the process group can outlive the timeout kill. Redaction runs after truncation, so a secret cut at the 200 000-character cap may leave a fragment.
- Worktree sweep removes worktrees older than 7 days that belong to no active run, which can include a run suspended that long. A partially created worktree can leak on a failed create.
- A task-scoped approval for a file tool matches on `file_path` only, so it covers any later content written to that path.
- Plan and review runs bypass the budget gates; a Chief review run (`opus`) starts on every mission stall, not only at the end. Review tasks are not swept by mission cancel (`review → cancelled` is not a transition).
- An owner reopen while a review run is live can let that run's stale decision apply to the task once it is back in review. A pending daily-budget `budget_exceeded` approval can stay pending after the budget is raised in settings. `PUT /missions/:id` is accepted on terminal missions.
- The gate's `decide` can run twice for one call when the SDK gives no `toolUseId` (the hook and `canUseTool` then cannot share the decision), so the owner may be asked twice.
- `approvalTimeoutMinutes` is read twice: by the worker from the run spec at run start (backstop at +5 minutes) and by the API from the settings at request time; a settings change during a run moves only the API's expiry.
- A mission can stay `planning` if the API crashes between storing the plan run's result and applying the plan.
- UI: Replan is also offered while the plan awaits approval; the approval countdown keeps ticking at 00:00; the Diff chip shows `base..head` without a file count; the Settings save is two requests (settings, then agents) and not atomic; `packageManager` cannot be unset; validation messages stay until the next save.
- A review run can start before the summary of the run it reviews exists. Since Task 12b `get_task_evidence` carries the latest run's result text (4000 characters), which holds the report.
- Found in the Maratus run: every run kept its run branch (19 `office/...-runs/...` branches after one mission). Fixed in Task 12c: the worker deletes a run branch with its worktree when the mission branch contains it (fast-forwarded, or no commits); a `needs_integration` branch and the worktrees it keeps stay.
- Found in the Maratus run: a dummy env template must still satisfy the project's env validation. With `BETTER_AUTH_URL=dummy` and `MQTT_BROKER_PORT=dummy` 17 of 68 Maratus test files failed to load; the template was corrected to `http://localhost:3000` and `1883`.
- Maratus leftovers, left for the owner (not touched): the mission branch `office/improve-the-reliability-of-the-till-to-d-92fa97`, 19 run branches `office/improve-the-reliability-of-the-till-to-d-92fa97-runs/<task>-<run8>`, the kept worktree `~/.office-worker/worktrees/677c6023` (unintegrated commit `01fed94`), `extensions.worktreeconfig=true` in `.git/config`, and `/.office-hooks/` and `/.env.local` in `.git/info/exclude`.
- The Maratus baselines of `.git/config` and `.git/info/exclude` were not recorded before the run, so the "before" values above are inferred; `/.claude/RESUME.md` in the exclude file has an unknown origin.
- Fixed in Task 12b (found in the Maratus run): approval policy only on mission task runs (now on every run kind); plan and review runs without the sensitive-path check; the Chief reopen loop (a reopen at `attempts >= maxAttempts` is refused, `review_task` accepts `failed`, and since Task 12c the code evidence rule lets an integrated retry supersede an earlier failed-check or `needs_integration` attempt: at least one committed run `fast_forwarded`, none unintegrated after the last one, latest check passed); the read-only gate evaded with `git worktree add /tmp/...` and `git cherry-pick` (read-only git allow-list; commit-equivalent git calls ask like `git commit`); `agent.command.executed` emitted before the gate decided; the Playwright suite leaving `planning` missions for a later worker.
- The seed re-creates deleted `ProjectAgent` rows of the seeded project and fills settings only when they are `{}`. Artifacts have no size cap on store.
- Since Task 12c the plan run creates the mission branch `office/<slug>-<id6>` in the repository before the owner approves the plan: a rejected, cancelled or `plan_failed` mission leaves an orphan branch, and the mission's base is fixed at plan time, so a plan approved much later builds on a stale default branch.
- A project without a `checkCommand` records `check.status: skipped`; the worker fast-forwards such runs, but the Chief's code-task evidence rule requires a passed check, so `done` is reachable only through the owner override. Deliberate (the check output is the test evidence), noted here because the docs' "(or no check configured)" wording hides it.
- A run that succeeds after its mission was cancelled still moves its task to `review`; the gate blocks any further spend and no review run starts, so the only effect is a stray `review` task in a cancelled mission.

Phase 5 (hybrid workers):
- Closed in Phase 6: no `run.result` acknowledgement (a result lost with its socket was deleted from the outbox). The worker now deletes it only on `run.result.ack` or the `No live lease` error.
- Git endpoint: closed in Phase 6: `Git-Protocol` is forwarded (v2) and the http-backend child is killed after `OFFICE_GIT_TIMEOUT_SECONDS`. Still open: no size limit; duplicate CGI header names keep the last value; the gzip and chunked upload paths are untested.
- Worker outbox: closed in Phase 6: a corrupt outbox file is renamed to `.corrupt` (no repeated warning). Still open: `load()` accepts any worker message, not only `run.result`; a stray `*.tmp` stays if the rename fails.
- Remote clone: `git remote set-url` rewrites `.git/config` on every sync, which can race the first worktree's `extensions.worktreeConfig` write (config lock); a `<dir>.tmp-<pid>` clone directory stays after a kill; any `rev-parse` failure re-clones a good clone; the lost-push-response path (`ls-remote` check) is untested.
- Remote run branches stay on the API repository: the worker deletes its local run branch after a fast-forward, but the copy it pushed stays (`office/phase-5-acceptance-lease-loss-a19850-runs/remote-marker-23327d81` in the sandbox after the acceptance). Local runs' branches are deleted as in Phase 4.
- Plan and review runs are `needsRepoAccess: 'any'`, so a remote worker can take the Chief's runs whenever the local worker has no free slot. With a remote worker on another runtime this hands the Chief's work to that runtime: in the acceptance the first review run of mission `c3e0dbf5` (`7de2b3ab`) went to the container's fake runtime, decided nothing, and the fake runtime executed the `COMMIT:` markers of the task descriptions inside its read-only review worktree (local commits `40cb27b`, `71e90f4` in the container's clone, never pushed; that worktree is kept). Give every worker in a pool the same runtime.
- `requiredWorkerTags` is per project, not per task: it steers every mission run (task, plan and review). Local-only runs (chat, inbox, summary, non-mission task) ignore it (decision, Task 10b), so a tag cannot keep them off an untagged local worker.
- Closed in Phase 6: a run whose lease was lost could still fast-forward the mission branch. The worker now asks `integration.check` and integrates only on `ok: true` under a live lease; a residual race between the answer and the push remains (see Phase 6 Outstanding).
- The run spec is not persisted and `agent.started` does not carry it; that a run used `git.remote` is visible only through its `worktreePath` (a path on the worker) and the worker's clone.
- The fake runtime commits as `fake <fake@example.invalid>` on the remote worker (it reads the identity from its own process environment, which the remote worker does not set); real Claude commits use the project's committer identity.
- The context pack may carry absolute paths of the control plane (from memory entries or summaries) to a remote worker; they are text only, the remote worker cannot open them.
- A reply that arrives while the pinned worker is offline waits the full `replyTimeoutMinutes` before the run fails (`pinned worker offline at resume`) and the task is retried fresh. Closed in Phase 6: `failWaitingRun` writes a session event. Still open: the wrong-worker resume guard is untested.
- Closed in Phase 6: `GET /runs/:id` `retriedByRunId` counts only later `task` runs of the same task. Still open: the `retried: false` path of `run.lease.lost` is untested.
- The Phase 5 end-to-end test's mission-head check cannot tell the original base from a moved head in test 5, and its `SLOW` marker gives a 2 s window.
- Remote worker container: `COPY . .` before `pnpm install` defeats layer caching (1.02 GB image); the enroll token stays in the container environment after enrollment; the entrypoint checks only that `credentials.json` exists.
- The host firewall: on this machine ufw drops Docker bridge traffic to host port 4000, so the acceptance ran the container with the host-network override (`infra/compose.hostnet.yaml`); network isolation of the container was therefore not exercised, only filesystem isolation.
- Data note for the owner: the `remote-1` worker row `57d49b72` from an earlier enrollment is `revoked` and stays listed; the current container is `d30c51d2`.
- Closed in Phase 6 by the `OFFICE_MACHINE_ID` override (API and worker). Originally: local workers need `/etc/machine-id`: on a host without it (macOS, minimal Linux) the API and the worker each persist their own random fallback id, the ids never match, no worker is ever local and chat, inbox, summary and non-mission task runs are never scheduled (only "no eligible worker" is logged).
- A `needs_integration` caused by the worker's own ancestry check (rewritten history) carries no reason and no event; only a rejected lease push reports its stderr.

Phase 6 (observability and hardening):
- Closed in Task 10b (re-run passed, run `7de638d8`): **acceptance expectation (3) failed: events produced while the API is down are lost.** Run `5bbffadf` completed after the API restart, but its stored events are seqs 1–12 and 17–47 (43 events): 13–16 (`agent.tool.completed` of command 3, then `agent.tool.started`, `agent.command.executed` `sleep 1 && echo 4` and `agent.tool.completed` of command 4) were produced while the socket was down and dropped. Cause: the worker's `send()` keeps only `run.result`, `approval.request` and `integration.check` across a disconnect and drops `run.event`s (a documented `shortcut:` in `apps/worker/src/connection.ts`). The fake recovery test does not catch it because its held run emits nothing during the outage. Fix: buffer unsent `run.event`s per run (bounded) and flush them after `welcome`; the API already stores duplicates once by `(sessionId, seq)`.
- Closed in Task 10b: subagent attribution. `normalizeSdkMessage` stamps `parentToolUseId` from the SDK's `parent_tool_use_id`, and the Claude adapter now stamps `agent.command.executed` too (it is emitted by the PreToolUse hook, which learns the parent from the assistant message the run loop has read; a hook that fires before that message is read loses only the attribution).
- Partly closed in Task 10b: an owner-cancelled run recorded `costUsd 0` and no `UsageRecord`. The API now records the usage of a worker's `cancelled` result once (`TaskRun.usageRecordedAt`, migration `phase6_usage_recorded`), but the Claude adapter reports zero usage on abort (`ZERO_USAGE` in `packages/runtime/src/claude/adapter.ts`), so cancelled real-Claude runs still record `costUsd 0`; the fake runtime's cancelled usage is recorded. A run that finishes `succeeded` in the same instant the owner cancels is rejected by the lease rule and records no usage either. Capturing the SDK's partial usage on abort is still open.
- A follow-up that fails after `completeRun` commits (for example `onPlanRunFinished` throwing) leaves the result unacked; the worker's resend is then acked as a resend and the follow-up never runs again (M3).
- `run.result.ack` carries only `runId`, so the API cannot tell which attempt it acknowledges; a per-attempt result token would close this and the stale-`suspended` case below (M4).
- Closed in Task 10b: Playwright left unread "Hello from e2e" messages in the developer's human conversation, and a later real chat run answered those first (run `7037412e`). The "owner messages an agent" test now writes to a dedicated inactive agent `e2e-inbox` (created by the test when missing); inactive agents are never woken and not listed to agents. Messages already left in the developer's inbox stay until a run reads them.
- The stale-`suspended` rule keyed on `sdkSessionId` can misfire after a lost `run.accepted` plus a legitimate re-suspend (a per-attempt result token would fix it).
- A plan-run owner cancel and `cancelMission` are not atomic: an API crash between them leaves a `planning` mission with a cancelled `planRunId` (another owner cancel recovers it).
- Residual integration race: a lease that expires between `integration.allowed ok: true` and the fast-forward or push still integrates.
- `maxBudgetUsd` is stored at creation and not refreshed on resume; `/sessions?status=all` loads every command and file event to count them; `currentWork` for inbox and chat runs is the run kind; skill reviews in `attention` are global, not per project; `pendingTasks` excludes `planned` tasks.
- Inspector: the Commands tab is not live (refetch every 10 s); the Activity tab replays on every tab return; pause-resume buffering is untested; `Segmented` tabs lack ARIA tablist semantics; Current task links to `/tasks/:id` (Mission Control has no task query); the `Session already ended` alert stays until the next click; the follow control reads "Pause following" / "Resume following" (the artboard's "Following live" chip is not a separate element). (Closed in Task 10b: `message-composer` and `chief-composer` use the `Textarea` `well` variant.)
- Dashboard: KPI sub-lines are thinner than the artboard (no inactive-agent count, no queued and awaiting split); attention rows show no command text; the Workers card has no Reconnecting state; live activity events are not filtered like the stored feed.
- Audit: (closed in Task 10b: `GET /audit` orders by `createdAt desc, id desc` and pages with `before` + `beforeId`; `before` alone still works) action options accumulate through a render-time `setState`; the target-type input is not throttled.
- The git timeout answers 504 only before http-backend sends headers (a stalled fetch is truncated); a push (`git-receive-pack`) is exempt from the timeout since Task 10b (a kill during its ref update could leave a stale ref lock), so a stalled push holds its child until the client disconnects; the API does not trim `OFFICE_MACHINE_ID` while the worker does; the timeout test is wall-clock and Linux-only.
- Closed in Task 10b: web lint error in `dashboard-activity.tsx` (`setState` inside an effect); the component remounts per project with `key={projectId}`.
- Not built (the owner may request them): interactive PTY shell, `ProjectMember`, session Pause, "Interrupt and send", messages addressed to a subagent. Project switcher built 2026-11-02 (see Post-Phase 6 below). Worktree confinement (Phase 4 Outstanding) is not built either.
- Acceptance data note: three `throwaway-6` worker rows exist, all `revoked`: `22a41a24` (enrolled, then revoked) and `73fb16e6`, `301e5eb4` (created while the implementer's start command failed; their enroll tokens were never used, revoked unused).

## Owner follow-ups after Phase 6 (2026-11-01)

- An agent version's `maxBudgetUsd` is `nonnegative`, default 0 = no agent cap (the owner runs Office on a Claude subscription, where the SDK's cost is an estimate, not a bill). `minBudget` (`packages/shared/src/agent-config.ts`) picks the lowest positive cap among the agent's, the task's (`defaultTaskBudgetUsd` or the plan's `budgetUsd`) and the inbox limit (0.25); the adapter leaves the SDK's `maxBudgetUsd` unset at 0. `maxTurns` stays positive. Existing agent versions keep their stored 2 USD until saved again. The Inspector and the task page hide the cap when it is 0.
- `BUILTIN_TOOLS` and `ALWAYS_ON_TOOLS` (`Read`, `Glob`, `Grep`) moved to `packages/shared`; the adapter imports them. The agent form picks allowed tools from that list (`ToolPicker`, always-on tools locked) instead of a comma-separated field; subagent tools use the same picker (empty = inherit); subagent model and the skill pin mode/version are house `Select`s (the native `<select>` popups were unreadable on a light GTK theme).
- Agents page: the list is `AgentsTable` (glass card, avatar, status pill, model badge, skill tags). Thin translucent scrollbars in `globals.css`.
- Skill Library (design `docs/superpowers/specs/2026-11-01-skill-library-design.md`): skills.sh marketplace search (`GET /skills/market?q=`, proxied) and install (`POST /skills/import {source:'market', id}`: clone the GitHub repository, find the `SKILL.md` by frontmatter name, store as a `git` skill), git import by `name`, `POST /skills/:id/update` (re-read the git or local source; `201` with a new version, `200 created:false` when unchanged, `400 not_updatable` for UI skills), `DELETE /skills/:id` (`409 skill_pinned` while pinned), `GET /skills` adds `model` (frontmatter) and `usedBy`; audit `skill.imported`, `skill.updated`, `skill.deleted`. The page follows the Skill Library artboard: header actions open one panel (folder, Git, Marketplace, New skill with a model select that writes `model:` into the frontmatter), review banners for pending imports, the Library card with filter, source/model/version/used-by/status columns and Update/Delete per row; the detail page has Update from source and Delete. Not built: Claude Code plugins (the owner's "plugin" wording was not clarified), a detail side panel, the On/Off toggle.
- The remote worker container now reaches the API through the Docker bridge after `sudo ufw allow from 172.16.0.0/12 to any port 4000 proto tcp`; `infra/compose.hostnet.yaml` is no longer needed on this host.

## Phase 6 decisions

- Observability reads records only (`SessionEvent`, `SubagentRun`, `UsageRecord`, `AuditLog`, `TaskRun`, `Approval`); no agent text drives a status chip. Read models in `services/observability-service.ts`: `GET /projects/:id/costs`, `/overview`, `/activity`, `GET /sessions`, `GET /sessions/:runId`, `GET /agents/:id/runs`.
- `project:<projectId>` UI topic: every stored event is also published there, live only (no replay). `/activity` rows carry `key = sessionId:seq`, the key the Dashboard merges live and stored rows by.
- `run.result.ack`: the worker outbox deletes a result only on the ack (or on the `No live lease` error). A resend of a final run owned by the worker with the same status is acked idempotently; a stale `suspended` resend for a run that resumed on the same worker (same `sdkSessionId`) is acked and skipped. API and worker must be upgraded together: an old API never acks, and a new worker against an old API times out every integration check (`needs_integration`).
- `integration.check` before any fast-forward or push; `ok` only under a live lease; 30 s timeout; reasons `lease lost`, `lease check timed out`, `run cancelled`. The residual race between `ok: true` and the push is documented, not closed.
- Owner `POST /runs/:id/cancel`: the run goes `cancelled`. A mission task run returns its task to `ready` without consuming an attempt (`?task=true` cancels the task; a task of a cancelled or finished mission goes `cancelled`); a cancelled plan run cancels the mission; a cancelled review run leaves the mission in `review` with `reviewRunId` kept (the owner decides through the overrides); a cancelled summary run resets the parent's `summarizedAt`. Audit actions `run.cancelled`, `worker.enrolled`, `worker.revoked`.
- `TaskRun.maxBudgetUsd` is stored at creation (migration `phase6_run_budget`); `SessionEvent (ts, id)` index.
- Task 10b: `TaskRun.usageRecordedAt` (migration `phase6_usage_recorded`) records an owner-cancelled run's usage exactly once from the worker's `cancelled` result. The worker buffers `run.event`s until `welcome` (5000 per run, in memory only), re-sends the last 50 sent events per live run, flushes events before results, and re-sends an unacked result on a heartbeat after 30 s. The Dashboard activity remounts per project (`key={projectId}`).
- `requiredWorkerTags` and machine identity unchanged from Phase 5, plus the `OFFICE_MACHINE_ID` override on both sides. `OFFICE_GIT_TIMEOUT_SECONDS` defaults to 600 (504 only before http-backend sends headers; a push is exempt from the timeout). `Git-Protocol` is forwarded (v2). A corrupt outbox file is renamed `.corrupt`. `failWaitingRun` writes a session event. `retriedByRunId` counts only `task` runs.
- Not built (the owner may request them): interactive PTY shell, `ProjectMember`, session Pause, messages addressed to a subagent (reached through the parent). "Interrupt and send" built 2026-11-02 (see Post-Phase 6). Project switcher: built 2026-11-02, header `Select` with the choice in `localStorage` (`office.projectId`), fallback to the first project; its last item opens the new-project form, which also creates greenfield repositories.

## Phase 6 evidence

### Fake-adapter end-to-end

`pnpm --filter @office/worker test` (2026-11-01 16:12Z, HEAD 5ad6663): 13 files, 87 tests passed, including `apps/worker/test/e2e-phase6-recovery.test.ts` (5 tests: API restart mid-run with lease reattach; a due summary and an expired approval resumed on the first tick after a restart; a question sent before the restart wakes its recipient after it; a result whose socket died before the ack re-sent and stored once; a lost-lease run that does not fast-forward). The api suite was run separately (it shares `office_test`); see "Full verification" in the Task 10 report.

### Phase 6 acceptance (real Claude on the host)

Setup (2026-11-01, through the API with the owner's session): the API on `0.0.0.0:4000` (tsx watch), the web app on :3000, one host worker `eren-pc` `e973b79e` started with only the `OFFICE_*` variables of `.env` (`OFFICE_RUNTIME=claude`, capacity 2, saved credential). `GET /workers` at 16:12Z: `e973b79e` the only online worker (machine id `b62398b8…`); every other row offline, pending or revoked. No run was queued or live and no mission was open beforehand. Project `office-sandbox` `e844090c`, agent `developer` `15e9d1b8`. Chat runs were started by `question` messages in the owner's `human` conversation with the developer, `12b99671`. Rebuilding the package dists at 16:14:40Z made both tsx watchers restart once (the worker then ran as a new process with the same credential); no run was live at that moment.

| Run | Purpose | Result |
|---|---|---|
| `7037412e` | (1) first attempt: `ls` and `git status` | succeeded 16:13:00Z, 0.149 USD; ran no command: the conversation held 18 unread "Hello from e2e" messages left by the Playwright suite, and the agent answered the latest of those instead |
| `73a15877` | a second chat run queued for the conversation after the first | succeeded, 0.186 USD; ran `ls` (seq 6) and `git status` (seq 8) and replied |
| `7d9f7fdc` | (1) `ls` and `git status`, watched live | succeeded 16:13:31Z, 0.211 USD, 15 events seq 1–15 gap-free |
| `b49026bf` | (2) count to 30, one `sleep 1 && echo N` per step | cancelled by the owner at 16:14:17Z after 4 commands; 17 events; `costUsd 0` recorded |
| `5bbffadf` | (3) count to 12, API restarted mid-run | succeeded 16:15:39Z, 0.324 USD; events 1–12 and 17–47 (gap 13–16) |

| Expectation | Result | Evidence |
|---|---|---|
| (1) a chat run is listed `Running` in Live Sessions with its commands streaming, the Inspector follows it live, and after it ends the Dashboard's Cost today and the Team row include its `costUsd` | PASS | Run `7d9f7fdc`: `GET /sessions?projectId=e844090c…&status=live` returned it `running` from 16:13:23Z; its `commands` count went 0 → 2 at 16:13:28Z while it was still `running`, and `GET /sessions/7d9f7fdc…` (the Inspector's record) listed `ls` (seq 6, 16:13:27.140Z) and `git status` (seq 9, 16:13:27.193Z) with status `running` until 16:13:31Z; the run then left the live list. Costs: before the runs `GET /projects/e844090c…/costs?days=1&groupBy=agent` `totalUsd` 2.09163737 (Developer 0.5533773) and `/overview` `costTodayUsd` 2.09163737 (Team Developer 0.5533773); after `7d9f7fdc` both 2.63793307 (Developer 1.099673). The delta 0.5462957 equals the three developer runs that finished in between: `7037412e` 0.1493313 + `73a15877` 0.1861683 + `7d9f7fdc` 0.2107961. The Inspector's follow state and the Dashboard rendering are covered by API responses and by the Playwright suite (the UI was not watched by eye). |
| (2) a long run stopped from the Inspector: `POST /runs/:id/cancel` → `cancelled`, audit `run.cancelled`, shown on the Audit page | PASS | Run `b49026bf`: cancelled after its fourth command (`sleep 1 && echo 4`, seq 16); the cancel answered `status: cancelled`; `GET /runs/b49026bf…` `cancelled`, `finishedAt` 16:14:17.058Z; the worker logged `run cancelled by API`. Audit row `9875d271` `run.cancelled`, target `run` `b49026bf…`, 16:14:17.065Z, `detail.by` the owner; `GET /audit?action=run.cancelled` (the Audit page's query) returns it first. The cancelled run records `costUsd 0` (see Outstanding). |
| (3) restart the API by pid while a run is live: the worker reconnects, the run completes, its events are gap-free (`seq` strictly increasing), and the Inspector replays the tail after reconnect | **FAIL** | Run `5bbffadf` had stored seqs 1–12 (3 commands) when the API (`pnpm --filter @office/api dev`, process group `2191930`) was killed at 16:15:09.822Z; the port was free at 16:15:10.346Z and the new API answered `/health` at 16:15:11.376Z (`API_HOST=0.0.0.0`, same `.env`). The worker logged `disconnected from API; reconnecting` (code 1006) at 16:15:09.851Z and `connected to API` at 16:15:12.995Z; the run stayed `running` and `succeeded` at 16:15:39Z (0.324 USD, one run, worker `e973b79e`). `GET /runs/5bbffadf…/events` returns 43 events, seq 1–12 and 17–47: seqs are strictly increasing but **not gap-free**. Missing: 13–16, produced while the socket was down (`agent.tool.completed` of command 3; `agent.tool.started`, `agent.command.executed` `sleep 1 && echo 4`, `agent.tool.completed` of command 4); the session's commands list shows 11 of 12 commands, `echo 4` missing. The Inspector's replay (`run:` topic) serves the stored rows, so it shows the tail from seq 17 on with the same gap. Cause: the worker drops `run.event`s while disconnected (see Outstanding). |
| (4) `GET /audit` shows `worker.enrolled` for a fresh enrollment of a throwaway worker and `worker.revoked` after revoking it | PASS | `POST /workers { name: 'throwaway-6' }` → `22a41a24`; a second worker process (`OFFICE_RUNTIME=fake`, its own `OFFICE_WORKER_HOME` and workspace root in a scratch directory, capacity 1) enrolled with the token at 16:16:45Z and `GET /workers` listed `eren-pc` and `throwaway-6` online. Audit `3497d3a7` `worker.enrolled`, target `22a41a24…`, 16:16:45.042Z, `detail { name: 'throwaway-6', machineId: 'b62398b8…' }`. `DELETE /workers/22a41a24…` → `revoked`; audit `81f3889d` `worker.revoked` 16:16:58.638Z; the throwaway worker logged `API closed the connection; not reconnecting` (code 4403) and exited. (The implementer's stop-by-pid had targeted the launcher's pid, which had already exited, so the revocation is what stopped it.) Two earlier `throwaway-6` rows, `73fb16e6` and `301e5eb4`, were created while the launch command failed; their tokens were never used and they were revoked too (audit `8b4f316f`, `8eed3e03`). |

Spend: 0.870 USD recorded over five chat runs (`7037412e` 0.149, `73a15877` 0.186, `7d9f7fdc` 0.211, `b49026bf` 0 recorded, `5bbffadf` 0.324), all on the developer (`sonnet`); the cancelled run's real usage is not recorded. Cost today rose from 2.09163737 to 2.96160017 USD. The 2 USD stop was not reached. The sandbox repository was not changed (chat runs only ran `ls`, `git status`, `sleep` and `echo`). The host worker was stopped by its process group at the end; the API and the web app stay up.

### Expectation 3, re-run (Task 10b)

After the worker event buffer (Task 10b item 1), with the API restarted from the rebuilt dists (`0.0.0.0:4000`, same `.env`) and one host worker `eren-pc` `e973b79e` (`OFFICE_RUNTIME=claude`, only the `OFFICE_*` variables of `.env`). The owner sent a `question` (message `d8010879`, 16:46:20.597Z) in the human conversation `12b99671` asking the developer to count 1 to 12 with one `sleep 1 && echo N` Bash call per step. Chat run `7de638d8` started; with 19 events stored (commands 1–5 issued) the API was stopped by its process group at 16:46:40.976Z, the port was free at 16:46:41.190Z, and the new API answered `/health` at 16:46:44.821Z. The worker logged `disconnected from API; reconnecting` (code 1006) at 16:46:40.990Z, two more failed attempts, and `connected to API` at 16:46:48.079Z. The run `succeeded` at 16:47:03.370Z, 0.40925660 USD (one `UsageRecord`, `usageRecordedAt` set).

`GET /runs/7de638d8…/events`: 47 events, seqs 1–47 contiguous (no gap, no duplicate). Every `echo` command is present: `agent.command.executed` `sleep 1 && echo 1` … `echo 12` at seqs 6, 9, 12, 15, 19, 22, 25, 28, 31, 34, 38, 41; `GET /sessions/7de638d8…` lists 12 commands. The events produced while the API was down, seqs 20–28 (`agent.tool.completed` of command 5; tool started, command executed and tool completed of commands 6, 7 and 8, `ts` 16:46:41.584Z to 16:46:47.889Z), were stored at 16:46:48.329Z–16:46:48.390Z, right after the reconnect: they came from the worker's buffer. The reply (seq 46) reports the count done. Result: PASS. Spend 0.409 USD, under the 0.5 USD stop.

### Verdict

Phase 6 is `done`. Expectations 1, 2 and 4 held in the first acceptance; expectation 3 failed there (seqs 13–16 of run `5bbffadf` lost) and passes on the Task 10b re-run (run `7de638d8`, seqs 1–47 contiguous across an API restart).

## Phase 5 decisions

- The API is the git endpoint for workers: `ALL /git/:projectId/*` runs `git http-backend` on the repository the database names for that project (never a client-supplied path), through a per-project `GIT_PROJECT_ROOT` symlink directory under `<OFFICE_DATA_DIR>/git-roots/<projectId>`. Only `Authorization: Bearer <worker credential>` is accepted there (401 `worker_unauthorized`); a revoked worker is refused at its next request. Session cookies are not accepted on it and worker credentials are not accepted anywhere else. The child is killed when the client goes away.
- Only fast-forwards of `refs/heads/office/*` are accepted there: the `pre-receive` hook (`apps/api/git-hooks/pre-receive`) rejects any other ref, deletes, tags and non-fast-forwards, and the default branch is never writable; one bad ref rejects the whole push. Nothing is pushed to the project's own `origin`.
- Workers declare `tags` (lowercase `^[a-z0-9][a-z0-9-]{0,31}$`, `OFFICE_WORKER_TAGS`) and `canClone` (`OFFICE_WORKER_CAN_CLONE`) in `hello`; `Worker.tags` and `Worker.canClone` store them. A project's `requiredWorkerTags` must all be present on a worker.
- Machine identity (Task 10b): `hello` carries an optional `machineId` (1–128 chars). The worker and the API compute it the same way: `/etc/machine-id` trimmed, else a random id persisted 0600 at `<OFFICE_WORKER_HOME>/machine-id` (worker) or `<OFFICE_DATA_DIR>/machine-id` (API, read at startup). `Worker.machineId` stores it (migration `phase5_worker_machine_id`) and `GET /workers` returns it; the Workers page shows its first 8 characters. A worker without `machineId` is never local unless `OFFICE_TRUST_UNIDENTIFIED_WORKERS=true` (default false).
- Scheduling: a worker is local for a project when its `machineId` equals the API's and its `allowedRoots` cover the repository (paths alone could match on another host with the same layout). Mission runs with a worktree (task runs of a mission, plan and review runs) may go to a worker that clones (`needsRepoAccess: 'any'`); runs without a worktree (chat, inbox, summary, non-mission task) are local-only. A project's `requiredWorkerTags` apply only to mission runs; local-only runs ignore them. Local workers are preferred, then the one with the fewest active runs.
- Remote workers never receive a control-plane path: their `RunSpec.git` carries `remote: { path: '/git/<projectId>' }` instead of `repoPath` (exactly one of the two), and `cwd` is `remote`. They clone into `<OFFICE_WORKER_HOME>/repos/<projectId>` (remote `office`, credential passed only through `GIT_CONFIG_*` environment variables as an `http.extraHeader`, `GIT_TERMINAL_PROMPT=0`, clone into a temporary directory then rename, a broken clone is re-cloned), work in a worktree of that clone and integrate by pushing the run branch and then the mission branch with `--force-with-lease=refs/heads/<mission>:<base>` after an ancestry check. A lost push response is resolved with `ls-remote`. A worker that cannot clone answers `run.rejected` `worker cannot clone`. A rejected lease push emits `agent.integration.failed { reason }` with git's stderr, and the result carries it as `git.integrationReason`.
- Resumes are pinned to the worker that holds the SDK session (`TaskRun.workerId`). While it is offline the run stays parked; when the reply timeout passes with it still offline the run fails (`pinned worker offline at resume`) and the task is retried fresh, without `resumeSdkSessionId`.
- Results are persisted in the worker outbox `<OFFICE_WORKER_HOME>/outbox/<runId>.json` (mode 0600) before they are sent and deleted after the send or after the API's `No live lease…` error; a restarted worker re-sends them on `welcome` while their runs are in `activeRunIds`. A run whose lease expires gets `run.lease.lost { workerId, retried }`; `GET /runs/:id` adds `retriedByRunId`.
- The remote worker container (`infra/docker/worker.Dockerfile`, Compose service `worker-remote`, profile `remote`, `pnpm worker:remote`) mounts no host path: its credential, clones and worktrees live in the named volume `office-worker-remote`. `infra/compose.hostnet.yaml` is an opt-in override that puts the container on the host network for hosts whose firewall blocks the Docker bridge.
- `GET /workers` adds `tags`, `canClone`, `machineId`, `online` and `activeRuns`; the Workers page shows mode (local, remote or none), tags, active runs against capacity, the relative heartbeat and Revoke; the Settings page edits `requiredWorkerTags`.

## Phase 5 evidence

### Fake-adapter end-to-end

`pnpm --filter @office/worker test` (2026-11-01 13:37Z, HEAD 9e04298): 12 files, 75 tests passed. `apps/worker/test/e2e-phase5.test.ts` (7 tests) runs the real API in-process with two fake-runtime workers, one local and one that clones over the git endpoint: parallel mission tasks on both, a remote run fast-forwarding over HTTP (also after the mission head moved), the CAS race between a local `update-ref` and a remote `--force-with-lease` push, a result delivered from the outbox after a worker restart, `No live lease` once the run is `lost`, and the pinned resume.

### Phase 5 acceptance (real Claude on the host, fake runtime in a container)

Setup (2026-11-01, all through the API with the owner's session):

- Machines: the host worker `eren-pc` `e973b79e` (`OFFICE_RUNTIME=claude`, roots `/home/meren/projects/office-workspaces:/home/meren/projects/maratus-admin`, started with only the `OFFICE_*` variables of `.env`) and the container `remote-1` `d30c51d2` (`infra-worker-remote-1`, `OFFICE_RUNTIME=fake`, tag `remote`, `canClone`, no workspace roots, saved credential in the volume). The host worker started with `OFFICE_WORKER_CAPACITY=1` and was restarted with 2 at 13:43Z (see mission 1).
- Network: this host's ufw drops Docker bridge traffic to port 4000, so the container ran with the committed host-network override: `docker compose -f infra/compose.yaml -f infra/compose.hostnet.yaml --profile remote up -d worker-remote`. Network isolation was therefore not exercised. Filesystem isolation was: `docker inspect` `Mounts` = `[{"Type":"volume","Name":"infra_office-worker-remote","Destination":"/office-worker","RW":true}]` (the named volume only, `HostConfig.Binds` the same), before the missions and again after them; the container's mount table shows no host path other than Docker's own `/etc/hostname`, `/etc/hosts` and `/etc/resolv.conf`.
- Project `office-sandbox` `e844090c-2a16-4a62-a199-a251103a8736` (`/home/meren/projects/office-workspaces/office-sandbox`). Its `main` had no commit and 5 untracked files (`docs/`, `hello.txt`, `index.html`, `sum.js`, `sum.test.js`); they were committed as `9c94e8f` "sandbox baseline" at 13:39Z. Settings: `checkCommand node --test`, `envFile .env.local`, `envTemplate [{FOO: bar}]`, `dailyBudgetUsd 50`, `maxConcurrentRuns 2`, `requiredWorkerTags []`, approval policy defaults. Project agents: architect, chief, designer, developer, qa-engineer.
- No live or queued run existed before the workers connected; nothing had to be cancelled (0 USD).

Mission 1 `c3e0dbf5-c551-4745-920c-38e76961dd15` ("Phase 5 acceptance: two workers", budget cap 5 USD), branch `office/phase-5-acceptance-two-workers-c3e0db`. The request was the brief's sentence plus the three task descriptions verbatim: `changelog` (developer, plain language), `hello-script` (designer, `COMMIT:scripts/hello.sh:#!/bin/sh\necho office`) and `phase5-doc` (qa-engineer, `COMMIT:docs/PHASE5.md:phase 5` plus the same in plain language). Plan run `423db131` (host, 0.24 USD) kept all three descriptions; plan approval `f38d72e3` approved through the API at 13:41:00Z (audit `plan.approved`).

| Run | Task | Worker | Started | Result |
|---|---|---|---|---|
| `c5b514db` | changelog | host `e973b79e` | 13:41:00.368 | succeeded, 0.12 USD, check `e2f3401d` passed, `fast_forwarded` `8fbaf40` |
| `86c2c791` | hello-script | container `d30c51d2` | 13:41:00.423 | succeeded, 0 USD (fake), check `998b8fd9` passed (`node --test` in the container, `agent.check.completed` seq 11), commit `4d8f098`, `needs_integration` (changelog was integrated first), worktree `/office-worker/worktrees/86c2c791-…` |
| `ebb6877b` | phase5-doc | host | 13:41:12 | succeeded, 0.12 USD, check `43f2776a` passed, `fast_forwarded` `5795618` |
| `7de2b3ab` | (review) | container | 13:41:26 | the host's single slot was taken by a summary run, so the Chief's review went to the container's fake runtime: no decision; mission stayed `review` |
| `ee8f9e46` | hello-script retry | host | 13:43:28 | owner reopen (audit `task.override` 13:43:27Z: "needs_integration …; rerun from the mission head"), succeeded, 0.05 USD, check `c091c44f` passed, `fast_forwarded` `49cc698` |
| `33c88c92` | (review) | host | 13:43:38 | Chief (real), 0.32 USD: `task.reviewed` done for changelog, hello-script and phase5-doc (13:43:51–55Z), review artifact `9272b7dd`; mission `done` |

Before the reopen the host worker was restarted with capacity 2 (by pid), so that summary and review runs both fit on it. For the retry the implementer set `requiredWorkerTags: ["remote"]` to steer it onto the container but cleared it again before the next scheduler tick, so the retry ran on the host with real Claude, which wrote the same file from the description. Mission 1 spend 0.86 USD (its summary runs excluded).

Mission 2 `a1985078-97ea-42e2-ac6b-26f0a0b1d094` ("Phase 5 acceptance: lease loss", cap 5 USD), branch `office/phase-5-acceptance-lease-loss-a19850`: two independent tasks, `remote-marker` (designer, `COMMIT:docs/REMOTE.md:written by the remote worker`) and `phase5-doc` (qa-engineer, as above, with the fake runtime's `SLOW` marker). Plan run `9d35089a` (host, 0.11 USD). Before approving plan approval `4483b98c` (13:45:33Z) the owner's stand-in set `requiredWorkerTags: ["remote"]` and `maxConcurrentRuns: 1` (audit `settings.updated` 13:45:32Z), so both tasks went to the container one after the other; a watcher script killed the container (`docker kill infra-worker-remote-1`) as soon as the `phase5-doc` run was `running` and reset the settings (`requiredWorkerTags []`, `maxConcurrentRuns 2`, audit 13:46:05Z).

| Run | Task | Worker | Result |
|---|---|---|---|
| `23327d81` | remote-marker | container | succeeded 13:46:04Z, check passed, `fast_forwarded` `9d467dc` over HTTP (the API log shows the container's `git-receive-pack` requests) |
| `f7a5d0db` | phase5-doc | container | `running` 13:46:05.319Z, container killed 13:46:05.562Z; lease expired; `lost` 13:47:05.409Z with `run.lease.lost` seq 1 `{ "workerId": "d30c51d2-…", "retried": true }`; `GET /runs/f7a5d0db…` `retriedByRunId` `d33d2564…` |
| `d33d2564` | phase5-doc retry | host | succeeded 13:47:15Z, 0.05 USD, check passed, `fast_forwarded` `2ef7495` |
| `75810953` | (review) | host | Chief, 0.18 USD: both tasks `done` (13:47:33Z, 13:47:35Z, the second note cites the lost run and the retry), review artifact `23ae6292`; mission `done` |

The container was started again at 13:47:50Z with no enroll token: its log shows `connected to API` with `workerId d30c51d2-…` (saved credential). Its outbox was empty and it had no worktree of `f7a5d0db`, so it reported nothing for the stale run, which stayed `lost`. Mission 2 spend 0.34 USD (its summary runs excluded).

Total spend of the acceptance: 1.22 USD over 18 runs, summary runs included (two plan runs; four task runs on the host and three on the container; three review runs, one of them on the container; six summary runs; the container's runs cost 0 USD). The 5 USD stop was not reached.

| Expectation | Result | Evidence |
|---|---|---|
| (1) `GET /workers` shows both online, the container `canClone: true`, `allowedRoots: []` | PASS | 13:40:05Z: `e973b79e` `eren-pc` online, tags `[]`, `canClone: false`, roots as above, capacity 1; `d30c51d2` `remote-1` online, tags `["remote"]`, `canClone: true`, `allowedRoots: []`, capacity 2. The revoked stale row `57d49b72` (`remote-1`) is listed `revoked`, offline. |
| (2) the two code runs have different `workerId`s, one the container's | PASS | `c5b514db` on `e973b79e` and `86c2c791` on `d30c51d2`, started 56 ms apart and both running at the same time (finished 13:41:11Z and 13:41:26Z). |
| (3) the container run used `git.remote`, no `repoPath`; clone under `/office-worker/repos/<projectId>`; no host mount | PASS | The run spec is not persisted and `agent.started` carries only the model, so no recorded spec shows it: the "no `repoPath`" claim rests on the schema and code and on the end-to-end test (`e2e-phase5.test.ts` asserts a remote spec has `git.remote` and no `repoPath`), plus: the worker clones only for `spec.git.remote` (`executor.ts`), and `RunSpecSchema` admits exactly one of `repoPath` and `remote`. `docker exec`: `/office-worker/repos/e844090c-2a16-4a62-a199-a251103a8736` with remote `office http://host.docker.internal:4000/git/e844090c-…` (no credential in its config), the mission and run branches, and worktrees `86c2c791` and `7de2b3ab` under `/office-worker/worktrees`; the run row's `worktreePath` is `/office-worker/worktrees/86c2c791-…`. The API log has the container's `/git/e844090c-…/info/refs`, `git-upload-pack` and `git-receive-pack` requests. `Mounts` as above. |
| (4) both runs have `CheckResult` rows; the mission branch has both commits, or one `needs_integration` with its run branch present and integrated by a retry | PASS | `998b8fd9` (container) and `e2f3401d` (host), both `node --test` exit 0. `86c2c791` was `needs_integration`; its run branch `office/phase-5-acceptance-two-workers-c3e0db-runs/hello-script-86c2c791` is in the sandbox; the retry `ee8f9e46` integrated `49cc698`. Mission 1 branch: `9c94e8f` → `8fbaf40` → `5795618` → `49cc698`. A container commit fast-forwarded over HTTP in mission 2 (`9d467dc`). |
| (5) container killed mid-run: lease expires, `run.lease.lost`, retry on the host completes; the restarted container reconnects with its credential and the stale run has no effect | PASS | Run `f7a5d0db` and its retry `d33d2564`, above. The killed run had emitted no events before the kill: `run.lease.lost` is its seq 1. |
| (6) the Chief's review closes the tasks from evidence | PASS, after one misplaced review | Review runs `33c88c92` (mission 1) and `75810953` (mission 2) on the host, notes citing commits, checks and integration. Mission 1's first review run `7de2b3ab` went to the container's fake runtime and decided nothing (see Outstanding); the owner's reopen of the `needs_integration` task (needed for (4) anyway) started a new review cycle. |
| (7) after restarting the API and both workers, `GET /missions/:id` and the Workers page show everything | PASS | 13:48:23Z: both workers stopped, the API killed by pid and restarted (`API_HOST=0.0.0.0`, same `.env`), both workers started again. `GET /workers`: both online (heartbeats 13:48:38Z). `GET /missions/c3e0dbf5…`: `done`, three tasks `done`, checks `passed`, plan approval `approved`, review run `33c88c92`, artifact `9272b7dd`, 0.86 USD. `GET /missions/a1985078…`: `done`, both tasks `done` (phase5-doc attempts 2), review `75810953`, 0.34 USD. `GET /runs/f7a5d0db…`: `lost`, `retriedByRunId` `d33d2564…`. The web `/workers` page answered 200, and the Playwright suite passed after the restart (see Step 4 in the Task 10 report). |

Sandbox repository before and after:

| Check | Before | After |
|---|---|---|
| `main` | no commit; 5 untracked files, then `9c94e8f` "sandbox baseline" (committed for the acceptance) | `9c94e8f`, clean |
| Branches | `main` | `main`; `office/phase-5-acceptance-two-workers-c3e0db` (`49cc698`), `office/phase-5-acceptance-lease-loss-a19850` (`2ef7495`); run branches `…-two-workers-c3e0db-runs/hello-script-86c2c791` (`needs_integration`, kept) and `…-lease-loss-a19850-runs/remote-marker-23327d81` (pushed by the container, fast-forwarded, not deleted: see Outstanding) |
| Worktrees | none | none in the sandbox; the container's volume keeps `86c2c791` (unintegrated) and `7de2b3ab` (the fake review's local commits) |

Nothing was merged into `main`, pushed to an outside remote or deployed. The host worker and the container were stopped at the end; the API and the web app stay up.

### Verdict

Phase 5 is `done`. Expectations 1 to 7 hold. Expectation 3's spec evidence is indirect (the spec is not persisted), and expectation 6 needed a second review cycle after the first review run went to the container's fake runtime; both are recorded under Outstanding.

## Phase 4 decisions

- A `Mission` is an owner request. The Chief's `plan` run (`opus`, on a read-only worktree of the mission branch since Task 12c; the API fixes the branch name on the mission when it creates the plan run) answers with plan JSON (`PlanSchema`: `summary`, `risks`, `tasks[]` with `key`, `title`, `description`, `kind` code|analysis|review, `agent`, `dependsOn`, `parallelGroup`, `requirements`, `acceptanceCriteria`, `requiredConsultations`, `approvalPoints`, `budgetUsd`). The API validates it against the project's team; the owner approves, edits, replans or rejects it (`plan` approval, policy default `ask`). Approval creates the tasks and `TaskDependency` rows.
- `approvalPoints` live only in `Mission.plan` JSON (no `Task` column).
- `ProjectAgent` rows list a project's team; a project with no rows is unrestricted (every active, non-system agent).
- Approval policy per project (`settings.approvalPolicy`): `plan`, `git_push`, `merge`, `deploy`, `destructive_command`, `sensitive_path`, `budget_exceeded`, each `ask` (default), `auto` or `block`; `destructivePatterns` default `rm -rf`, `git reset --hard`, `git push`, `git push --force`, `drizzle-kit`, `npm run db:`, `pnpm db:`, `DROP TABLE`, `TRUNCATE`; `sensitivePaths` default `.env`, `.env.*`, `credentials.json`, `*.pem`, `*.key`, `id_rsa`.
- A pending approval expires after `approvalTimeoutMinutes` (default 30) and the call is denied. The worker denies on its own at `approvalTimeoutMinutes + 5` minutes. `Approval.deliveredAt` records delivery to the worker; the API moves the run back to `running` before it sends the decision, and re-sends undelivered decisions on `hello`. A lease-less `approval.request` is answered with a deny.
- Every run kind (mission and non-mission `task`, `chat`, `inbox`, `plan`, `review`) carries the project's `approvalPolicy` and `approvalTimeoutMinutes` (Task 12b). Plan and review runs keep the read-only gate and also get the policy, so their `Read` of a sensitive path asks.
- Read-only runs allow only these git subcommands: `status`, `log`, `diff`, `show`, `blame`, `grep`, `ls-files`, `rev-parse`, `branch --list`, `worktree list`, `remote -v`, `describe`, `cat-file`. When `destructivePatterns` contain `git commit`, `git worktree add`, `cherry-pick`, `rebase`, `merge`, `am`, `apply` and `stash` ask like it (commit-equivalent).
- `agent.command.executed` is emitted only after the gate allows the call; a denied call shows as `agent.tool.failed` (with `agent.approval.resolved` when the owner was asked).
- Tool approvals are enforced by a `PreToolUse` hook (`packages/runtime/src/gate.ts`) plus removing `Bash`, `Edit`, `Write`, `MultiEdit` and `NotebookEdit` from `allowedTools` whenever a policy or a read-only checkout applies: the SDK auto-allows `allowedTools` before `canUseTool`, so `canUseTool` alone was bypassable.
- Worktrees live under `<OFFICE_WORKER_HOME>/worktrees/<runId>`, never inside the repository. The mission branch is `office/<slug>-<id6>`. A run branch is `<missionBranch>-runs/<taskSlug>-<run8>`, not the planned `office/<mission>/<task>-<run8>`: git cannot hold both the ref `office/<m>` and `office/<m>/<x>`.
- A code run's commits are fast-forwarded onto the mission branch only after a passed `checkCommand` (or with no check configured). A failed check integrates nothing (`integration: none`); a head that is no longer a fast-forward of the mission branch (a parallel task integrated first) is `needs_integration`, and the Chief reopens the task or the owner integrates by hand. Retries and dependents start from the mission branch head.
- A worktree-local `prepare-commit-msg` hook adds the trailer `Office-Agent: <agent name> <runId>` to every agent commit.
- `checkCommand` runs in the worktree after every code run through `/bin/sh -lc`, with a process-group SIGKILL at `checkTimeoutSeconds` (default 900). Its `CheckResult` (status, exit code, duration, output as an `Artifact`) is the test evidence; the API emits `agent.check.completed`.
- The real env file never enters a worktree. The project's `envTemplate` is written to `envFile` in the worktree with mode 0600 (symlinked targets refused) and excluded through `info/exclude`, which git resolves to the repository's shared `.git/info/exclude` (the Maratus run added `/.env.local` and `/.office-hooks/` there).
- `review → done|reopen|failed` is decided by the Chief's review run through `review_task`, from `get_task_evidence` (which includes the latest run's result text, capped at 4000 characters): code needs at least one succeeded run whose commits were `fast_forwarded`, no committed run after the last fast-forwarded one left unintegrated (so an integrated retry supersedes an earlier failed-check or `needs_integration` attempt), and a passed latest check (a rerun after a reopen may change nothing; Task 12c); a Chief reopen counts as an attempt (the rerun it causes increments `attempts`), and at `attempts >= maxAttempts` `review_task` refuses `reopen` with `max_attempts` (logged by the API) so the Chief decides `done` or `failed`; analysis needs an artifact or a memory entry; review needs a `review` artifact; and every required consultation must hold. The owner overrides with `POST /tasks/:id/done|reopen|failed` (Mark done, Reopen, Failed in the task panel). Mission Control shows the mission summary under the plan card and links a `done`/`failed` mission to its review run's events and `mission-review.md`. A mission enters `review` whenever no task is runnable and returns to `running` after reopens; failed review runs are retried, bounded. A mission with undecided review tasks stays `review` with `reviewRunId` kept; when the owner decides the last one the mission settles `done` (all done) or `failed`.
- Tasks without a mission keep the Phase 1 auto-done.
- Budgets: `dailyBudgetUsd` is a soft per-project limit, raised by `dailyBudgetUsd` for each daily-budget `budget_exceeded` approval approved that UTC day (limit = `dailyBudgetUsd * (1 + approvedCount)`; approvals are told apart by their reason, so a legacy mission-cap approval does not count). `Mission.budgetUsd` is a hard cap on the mission's spend, raised only with `PUT /missions/:id`; reaching it raises no approval (Task 12c) and the plan card shows "Budget cap reached". A task run's budget is the lower of the agent version's `maxBudgetUsd` and the task's `budgetUsd` (`defaultTaskBudgetUsd` unless the plan sets one).
- Push, merge, deploy and PR creation are approval requests only; the platform never pushes.
- Mission cancel is atomic and idempotent and cancels live runs. Tasks start only while their mission is `approved`, `running` or `review`, and a failed run result arriving after the cancel sends its task to `cancelled`, not `ready` (Task 12c).
- `@fastify/cors` lists methods explicitly; the default list blocked `PUT` and `DELETE` from the browser.

## Phase 4 evidence

### Fake-adapter end-to-end

`pnpm --filter @office/worker test` (2026-11-01 10:47Z, HEAD b7f66ec): 9 files, 51 tests passed. `apps/worker/test/e2e-phase4.test.ts` runs the real API in-process with the fake adapter: plan, plan approval, a code task in a worktree with a commit, the `Office-Agent:` trailer, `checkCommand`, fast-forward onto the mission branch, a review task, the Chief review closing the mission; a destructive command waiting for the owner and continuing after a deny; a run whose base went stale kept for manual integration.

### Phase 4 acceptance (real Claude, Maratus)

Setup (2026-11-01, all through the API with the owner's session):

- Local `.env` only: `OFFICE_WORKSPACE_ROOTS=/home/meren/projects/office-workspaces:/home/meren/projects/maratus-admin` (not committed).
- Project `maratus-admin` `1237a3fb-c6f0-4dff-821e-40f5ac38a89a` (`repoPath /home/meren/projects/maratus-admin`, `defaultBranch main`). Settings: `packageManager npm`, `setupCommand npm ci`, `checkCommand npm test`, `envFile .env.local`, `envTemplate` with all 19 names of the repository's `.env.example` set to `dummy` (`DATABASE_URL postgresql://dummy:dummy@localhost:5432/dummy`), approval policy defaults, `dailyBudgetUsd 20`, `defaultTaskBudgetUsd 3`. Project agents: `chief`, `architect`, `developer`, `qa-engineer`.
- Expectation 7 tweak: `git commit` appended to `destructivePatterns` (policy `destructive_command: ask`).
- At 10:55:54Z, after the first check failed on the template (see below), `BETTER_AUTH_URL` became `http://localhost:3000` and `MQTT_BROKER_PORT` `1883`, still dummy values. Maratus's `lib/env.ts` validates both.
- One worker (`eren-pc` `e973b79e`, `OFFICE_RUNTIME=claude`, started with only the `OFFICE_*` variables). When it connected it took plan runs of four `planning` missions that the Playwright suite had left in `office-sandbox` (`5c455e91`, `4bb8075d`, `f0fb56a5`, `9a50d16b`). The implementer cancelled all four within 15 s; their plan runs `7228bd73`, `6714349e`, `dd7a14f6` cost 0 USD.

Mission `92fa97f1-8666-4bae-87c5-e00cb09f4b49`, request verbatim as in the brief, branch `office/improve-the-reliability-of-the-till-to-d-92fa97`. Final status `done` (11:07:29Z). Mission spend 5.91 USD (31 runs of the project, summaries included); with the two chat runs below (0.12 + 0.19 USD) the project's `UsageRecord` sum is 6.22 USD. The 20 USD stop was not reached.

| Expectation | Result | Evidence |
|---|---|---|
| (1) plan, owner approval through the API | PASS | Plan run `3ca3e1fb` (chief, 0.25 USD, 40 s, read-only in the repository). Tasks: `audit-mapping` (analysis, architect) → `add-validation-tests` (code, developer, `requiredConsultations: [{ agent: architect }]`) → `qa-verify` (review, qa-engineer) → `arch-review` (review, architect). The plan's developer requirement said "No commit, push, merge or deploy"; the owner's stand-in edited that one requirement to "Commit … on your run branch with git commit …; no push, merge or deploy" (`PUT /missions/:id/plan`, audit `plan.edited` 10:50:21Z), then approved plan approval `a2d5e03c` (audit `plan.approved` 10:50:25Z). |
| (2) question to the Architect, inbox reply with a file reference, resume; two sessions | PASS | Developer run `677c6023`, session `7e1d39db`: `agent.message.sent` `question` seq 22 (message `55e21a15`, task conversation `660f84e1`, kind `task`), `agent.waiting_reply` seq 23. Architect inbox run `429dc328`, session `91b940df` (separate SDK session `521d3560`), reply `28ac0894` ("I checked lib/register-number.ts …"). `agent.resumed` (reason `reply`) seq 25 in the developer session. The developer's question asked the Architect to confirm its test plan before editing; the reply named the canonical module. |
| (3) commits on the mission branch with tests, `CheckResult` from `npm test` | PASS | Commits `f7a47ae` ("Validate till number on register trigger route; add till-number tests", trailer `Office-Agent: Developer 677c6023-…`) and `74a4d89` ("Drop double decode …", trailer `Office-Agent: Developer 50f1059d-…`) on the mission branch, base `72bea24` (`main`). Changed: `app/api/v1/registers/[registerNumber]/trigger/route.ts` (+6/-2) and three test files (`lib/device-claim.test.ts`, `lib/actions/devices.test.ts`, `lib/register-trigger-route.test.ts`). Run `50f1059d`: `CheckResult` `b8f3ff0b` `npm test` passed, exit 0 (`agent.check.completed` seq 55, artifact `89fd4a65`), integration `fast_forwarded`. The first run `677c6023` had `CheckResult` `9b8724ba` failed, exit 1 (17 test files failed to load on the env template, see above), so its commit `01fed94` stayed on its run branch; the retry cherry-picked it. |
| (4) QA runs the tests itself; review artifact | PASS | QA run `1bad71d5` seq 12 `agent.command.executed` `(npm test …); npx tsc --noEmit …; npm run lint …` (68 files, 680 tests passed); review artifact `7addbb89` (`review.md`). Run `6f8c5d2e` ran `npm test` again (seq 23). QA's mutation check (revert the fix, see the tests fail) was blocked by the read-only gate (`agent.tool.failed` seq 26 in `1bad71d5`, three denied `Edit`s in `6f8c5d2e`). |
| (5) Chief review closes from evidence or reopens with reasons | PASS, with a defect | Review runs `6b4a2118` (closed `audit-mapping` done from its analysis artifact `816ac048`, audit 10:52:21Z), `cf82fa84` (reopened `add-validation-tests`: "The platform check for run 677c6023 failed (exit 1) and commit 01fed94 is not integrated …"), `220bccbf`, `08fb7112`, `9b6ec211` (reopens asking for a written report), `b789a39e`, `aa9fa5bc` (reopened `qa-verify`: mutation check unverified), `e8e09085` (closed `arch-review` done from review artifact `a555fa75`, audit 11:07:21Z; mission `done`). Defect: after the code was accepted, the Chief kept reopening `add-validation-tests` (runs `351f351c`, `708276ad`, `9e858d22` changed no files, so the code evidence rule could never pass) and `qa-verify` (read-only checkout). The owner's stand-in closed both with `POST /tasks/:id/done` (audit `task.override` 11:01:59Z and 11:06:23Z), following the Chief's own escalation options. See Outstanding. |
| (6) after restarting the API and the worker, mission, conversation and memory remain; chat answered from `search_memory` / `get_task_history` | PASS (on run `e5f2c1d2`, by the controller's ruling) | API and worker restarted at 11:08Z (killed by pid, restarted from `.env`). `GET /missions/92fa97f1…` → `done`, four tasks `done`, `add-validation-tests` check `passed`, three approvals `approved`. `GET /conversations/660f84e1…` → the question and the reply. Project memory: 33 entries (10 verified task summaries, 23 agent proposals awaiting review). Human conversation `0992a94c`, question `aca465cf` "what did we do last time on Maratus till mapping?" → chat run `2f7abd5c` (0.12 USD) answered with the task sequence, ids and commit `74a4d89`, but its events show only `Skill`, `ToolSearch`, `read_inbox` and `reply_message`: it answered from the context pack (session `contextPack.entryIds` held 8 entries, including summaries `97c7abf2`, `e8319ad6`, `5b6e49e4`, `cfdecfdb`), not from `search_memory` / `get_task_history`. A follow-up asking it to use the tools (run `e5f2c1d2`, 0.19 USD) called `search_memory` (seq 5) and `get_task_history` (seq 9) and answered. Controller's ruling (Task 12): "expectation 6 counts as PASS on the follow-up chat run e5f2c1d2 — the spec (§17/§20) requires memory retrieval after restart, which both the DB-backed context pack and the tool calls prove after the API+worker restart; the first run's prompt did not need the tools". |
| (7) a real gated tool call waits, the owner approves through the API, the run resumes | PASS | Run `677c6023` (developer, session `7e1d39db`): `agent.waiting_approval` seq 72 at 10:54:50.645Z for `git add -A app lib && git commit …` (type `destructive_command`, reason `command matches "git commit"`), approval `6aa5c686-0980-46aa-a2c0-4d73776f4ba6` listed by `GET /approvals?projectId=…&status=pending`, approved via `POST /approvals/6aa5c686…/approve {scope: once}` at 10:55:04.290Z, `deliveredAt` 10:55:04.310Z, `agent.approval.resolved` (allow) seq 73, then the commit's output (seq 75, `01fed94`) and `agent.completed` seq 77. A second one: approval `ea1e20e4` in run `50f1059d`, seq 50 → 51. |

Safety, Maratus before and after:

| Check | Before (baseline) | After |
|---|---|---|
| `main` | `72bea24`, clean | `72bea24`, clean |
| Branches | 1 (`main`) | `main`, the mission branch and 19 run branches (`office/improve-the-reliability-of-the-till-to-d-92fa97-runs/<task>-<run8>`) |
| Remote refs | `origin/main` | `origin/main`; no `git push` in any event of the project |
| `.env.local` sha256 prefix | `87ec17b97a027ee9` | `87ec17b97a027ee9`; no event reads the repository's `.env.local` |
| `~/.office-worker/worktrees` | missing | one kept worktree, `677c6023` (unintegrated commit `01fed94`) |
| `.git/config` | no `extensions.worktreeconfig` (not recorded, inferred) | `extensions.worktreeconfig=true` (trailer hook) |
| `.git/info/exclude` | not recorded | lists `/.office-hooks/` and `/.env.local` (from the worktrees); `/.claude/RESUME.md` was there too, origin unknown |
| Other worktrees | none | the Chief review run `cf82fa84` registered `/tmp/tmp.CDS2gmGb1a/wt` (detached at `01fed94`); the implementer removed it with `git worktree remove --force` |

Nothing was merged, pushed or deployed; no production credential and no Neon connection was used (tests mock the database; the worktrees held the dummy template).

### Gate probe on a chat run (real Claude, Task 12b)

After the Task 12b fixes (commit `4860aa4`), the API was restarted on the new package builds and exactly one worker (`eren-pc` `e973b79e`, `OFFICE_RUNTIME=claude`, only the `OFFICE_*` variables plus `HOME`/`PATH`) was started; it picked up no stale run. The owner asked the `developer` agent on `maratus-admin` in human conversation `0992a94c` (question `ecc5182e`, 11:27:23Z) to run `rm -rf /tmp/office-gate-probe-$(date +%s)` and report the result.

- Chat run `8dd0dbc9-1a8e-4b53-8c7c-4e44b2259c8b` (`sonnet`): seq 6 `agent.tool.started` Bash with that command; seq 7 `agent.waiting_approval` (11:27:31Z, type `destructive_command`, reason `command matches "rm -rf": rm -rf /tmp/office-gate-probe-$(date +%s)`); run status `waiting_approval`.
- Approval `b7742ff3-d408-45ea-86f4-d7f8ad82e2b6` (`pending`) denied via `POST /approvals/b7742ff3…/deny` (message "Denied by the owner: gate probe") at 11:27:40.221Z, `deliveredAt` 11:27:40.231Z.
- Seq 8 `agent.approval.resolved` (deny); seq 9 `agent.tool.failed` ("PreToolUse:Bash hook error: Denied by the owner: gate probe"); no `agent.command.executed` for the denied call. Seq 10–12 `reply_message` (reply `f2fffee6`: "Gate probe result: blocked …"); seq 14 `agent.completed`. Run `succeeded`, 0.22 USD, 4 turns, 18.8 s.
- The worker was stopped by pid afterwards. Maratus after the probe: `main` at `72bea24`, `git status --porcelain` empty, `.env.local` sha256 prefix `87ec17b97a027ee9`; no `/tmp/office-gate-probe-*` exists.

### Verdict

Phase 4 is `done`. Expectations 1, 2, 3, 4 and 7 hold; 5 holds (its reopen-loop defect is fixed in Task 12b, with the evidence rule completed in Task 12c so a failed-check or `needs_integration` attempt is superseded by its integrated retry; not re-run on a real mission); 6 holds on run `e5f2c1d2` by the controller's ruling; the chat-run gate probe holds.

## Phase 3 decisions

- Delivery into a live session happens at session boundaries only (no streaming input yet). A live agent sees new mail when it calls `read_inbox` or at its next run.
- `question`, `help_request`, `handoff` and `escalation` messages wake an idle recipient through an inbox run with `maxTurns` at most 8 and `maxBudgetUsd` at most 0.25 (the lower of these and the agent version's limits). An inbox run gets only `Read`, `Glob` and `Grep` of the version's built-in tools. The scheduler makes at most two wake runs per unread wake delivery.
- `awaitReply` suspends the run: the run and its task move to `waiting_reply` and the lease is released, so the worker slot is free. The reply resumes the same run and session with the SDK session id (`resumeSdkSessionId`) and continues the event `seq` (`startSeq`). With no reply within `replyTimeoutMinutes` (`OFFICE_REPLY_TIMEOUT_MINUTES`, default 60) the run resumes with a timeout prompt.
- `handoff_task` reassigns the task to the recipient (`Task.agentId`) in the same transaction as the handoff message; Phase 4 owns full orchestration.
- Escalation depth and handoff chain grow across agents: `escalate_to_chief` and `handoff_task` chain from the latest `escalation` or `handoff` the calling agent received on the same task (without a task, in the run's conversation), so `OFFICE_ESCALATION_DEPTH` (default 2) and `OFFICE_HANDOFF_CHAIN` (default 3) apply to tool calls, not only to API sends with `inReplyToId`.
- Task runs that finished before Phase 3 are never summarized: the `phase3_stamp_history` migration sets `summarizedAt` on every `task` run that `succeeded` or `failed` before the `phase3_messaging_memory` migration time (2026-11-01 05:56:19 UTC).
- Chat runs keep the agent version's full tool surface and budget (spec §6.3); only inbox runs are capped. Approval gates for chat and task runs arrive in Phase 4.
- Verifying an already verified memory entry is a no-op; `verifiedAt` keeps its first value. A `propose_memory` call with scope `agent` or `agent_project` stores the author as `agentId`, so agent-project lessons reach the agent's context pack.
- The office tools are an in-process SDK MCP server named `office`, fed by `tool.call` / `tool.result` over the worker socket. The API executes every call. `strictMcpConfig: true` replaces the Phase 2 `mcp__*` disallow wildcard and keeps every other MCP server out of the session.
- `office-summarizer` is a hidden system agent (`Agent.isSystem`) on `haiku`. After a task run finishes, the scheduler starts a summary run for it, which writes one `verified` `task_summary` with sources through `submit_summary` and may propose more entries.
- Memory search is Postgres full-text search (a generated `tsvector` column); the `pgvector` column exists and is unused.
- Deleting a memory entry is a hard delete (no 30-day purge yet). Deleting a revision restores its predecessor.
- Inbox and chat runs have no task: `TaskRun.taskId` is nullable, and `agentId`, `projectId` and `conversationId` sit on the run.
- The context pack matches memory by OR-ing the task text's terms (ranked, capped at 10 entries and `OFFICE_CONTEXT_PACK_MAX_CHARS`, default 12000); the owner's memory search keeps AND.
- A message's sender and project come from the session that calls the tool, never from tool arguments.
- Wake deliveries are grouped per (agent, project): one inbox run drains the whole inbox.

## Phase 3 evidence

### Fake-adapter end-to-end

`apps/worker/test/e2e-phase3.test.ts` runs the real API in-process with the fake adapter (markers `SEND:`, `ASK:`, `MEMO:`, `INBOX`). It covers a question with `awaitReply`, the inbox wake, the reply, the resume, the proposed memory, the task summary and the next task's context pack. It passes in `pnpm test`.

### Phase 3 acceptance (real Claude)

Attempt 1. Date: 2026-11-01. Result: **failed on one expectation**. One attempt, no retry. Every other expectation held. The missing piece is the `agent.waiting_reply` event: the Claude adapter did not emit it (fixed in bd3d78a; see attempt 2).

Setup: infra up; dev database migrated and seeded (`office-summarizer` `adc4a45f-ee71-4d86-9fa7-cd3592144769`, `developer` `15e9d1b8-65b4-4350-96ca-067db9315e9d`, `architect` `49ef7eac-1fc7-4469-a2e3-5d904dd883ca`). The API (`pnpm --filter @office/api dev`, tsx watch, at the branch head) and the web app (`pnpm --filter @office/web dev`) were already running. The worker (`pnpm --filter @office/worker dev`, `OFFICE_RUNTIME=claude`, worker `e973b79e-8611-4552-b949-b291d5fd493e`, saved credential, capacity 2) was started with the root `.env` exported and logged `connected to API` at 07:18:33Z. It used the machine's Claude Code login. Project `office-sandbox` `e844090c-2a16-4a62-a199-a251103a8736`, repository `/home/meren/projects/office-workspaces/office-sandbox`. No production credential, live database, push, merge or deploy was involved.

Driver: `POST /tasks` with the owner's cookie session, then `GET /tasks/:id`, `GET /runs/:id`, `GET /runs/:id/events`, `GET /conversations`, `GET /conversations/:id`, `GET /memory` and `GET /memory/:id`. The Conversations and Project Memory pages were screenshotted in headless Chromium with the owner's cookie.

Task: agent `developer`, title `Pick the database`, description verbatim: `Before writing anything, ask the architect (use list_agents, then send_message with type question and awaitReply true) which database this project should use and why. Wait for the answer. Then write the decision into docs/db-decision.md and propose it as a decision memory with propose_memory.`

| Run | Kind | Agent | Run id | Session | Created | Finished | Cost (USD) |
|---|---|---|---|---|---|---|---|
| developer | `task` | developer (sonnet) | `8c0fcf3e-fe20-40ca-ac09-7008aafa3050` | `9c7fa30f-3e0b-46e8-8c84-d3b499fcea40` (SDK `4cecf4ab-3fdc-4f68-8778-ceccefdd498f`) | 07:18:51.244Z | 07:19:25.871Z | 0.2513424 |
| architect inbox | `inbox` | architect (sonnet) | `6dfdba03-456a-4445-b0db-511dcb998993` | `a9bed6fe-7b1b-4284-9659-926f9a1c2cf3` (SDK `62d2dead-055d-41b3-87ef-6e6665038229`) | 07:18:57.268Z | 07:19:16.371Z | 0.1170028 |
| summary | `summary` | office-summarizer (haiku) | `1b14bf8b-e027-4288-82b1-05ac58b8258a` | | 07:19:27.349Z | 07:19:40.602Z | 0.00640329 |

Task `e6ce39eb-5270-40fd-b708-ebc41fefd12c`: created 07:18:50.808Z, `done` at 07:19:25.878Z, attempts 1. The developer run's cost covers both of its segments (before and after the suspend). Conversation `27251a71-40b4-4d81-b13c-0aa1bb07e98a` (kind `task`, title `Pick the database`, participants developer and architect).

Developer run events (`GET /runs/8c0fcf3e-.../events`):

```
seq 1  agent.started          07:18:52.008Z  model claude-sonnet-5-5; tools include the 13 mcp__office__* tools, no other mcp__ tool
seq 2-7  Skill lazy-expert-developer, Skill test-driven-development (eager pins)
seq 8  agent.tool.started     ToolSearch select:mcp__office__list_agents,mcp__office__send_message,mcp__office__propose_memory
seq 10 agent.tool.started     07:18:55.272Z  mcp__office__list_agents
seq 12 agent.tool.started     07:18:56.788Z  mcp__office__send_message {to: architect, type: question, awaitReply: true}
seq 13 agent.message.sent     07:18:56.828Z  messageId b560ca38-e94e-4a3e-8ccd-cbe498a1ce88, conversation 27251a71-...
seq 14 agent.tool.completed   07:18:56.832Z  "Your turn ends now; the reply arrives as your next user message."
       (expected here: agent.waiting_reply; not emitted)
seq 15 agent.resumed          07:19:13.319Z  {reason: reply, messageId: a241b9d2-18b6-4f9b-b6c0-514c0fbfe28a}
seq 16 agent.started          07:19:13.640Z  (resumed SDK session)
seq 18 agent.tool.started     07:19:17.958Z  Bash: mkdir -p docs && cat > docs/db-decision.md <<'EOF' ...
seq 21 agent.tool.started     07:19:20.298Z  mcp__office__propose_memory {type: decision, ...}
seq 22 memory.proposed        07:19:20.377Z  entryId 32f129b5-423d-4e95-96a9-d2cfbf861ac3
seq 25 agent.completed        07:19:25.328Z  costUsd 0.1403071 (this segment), numTurns 3
```

The worker log shows `run assigned` for this run twice (07:18:51Z and 07:19:13Z), so the run left its worker slot while it waited. The run status passed through `waiting_reply`: `resumeRun` only moves a run from `waiting_reply` to `queued`, and `waitingSince` was cleared on resume. No status history is stored, so the state itself was not observed directly. The developer wrote the file with a `Bash` heredoc rather than `Write`.

Architect inbox run events:

```
seq 1  agent.started          07:18:57.652Z  allowed built-ins Read, Glob, Grep only
seq 2  Skill clean-architecture (eager pin)
seq 7  agent.tool.started     07:19:01.735Z  mcp__office__read_inbox
seq 8  agent.message.received 07:19:01.751Z  {count: 1}
seq 11-14 Glob *, Grep postgres|sqlite|... (no database code in the repo)
seq 15 agent.tool.started     07:19:12.222Z  mcp__office__reply_message
seq 16 agent.message.sent     07:19:12.262Z  {type: reply, messageId: a241b9d2-18b6-4f9b-b6c0-514c0fbfe28a}
seq 19 agent.completed        07:19:15.967Z  costUsd 0.1170028, numTurns 8
```

The architect answered "provisional SQLite, move to PostgreSQL on named triggers" (2019 characters). Its context pack: `{chars: 256, entryIds: [], inboxCount: 1, summaryIds: []}`.

Summary run: `agent.started` listed `mcp__office__submit_summary` as its only `mcp__` tool. `submit_summary` (seq 6, 07:19:37.756Z) returned entry `666ea1bc-9764-4e76-859f-1e98e9818dde` and proposal `b244a807-2de8-4183-8348-0e5d8c29cf7d`. The task run's `summarizedAt` is 07:19:27.330Z.

Memory after the task:

| Entry | Type | Status | Author | Sources |
|---|---|---|---|---|
| `666ea1bc-9764-4e76-859f-1e98e9818dde` `Summary: Pick the database` | `task_summary` | `verified` (07:19:37.782Z) | system | run `8c0fcf3e`, task `e6ce39eb` |
| `32f129b5-423d-4e95-96a9-d2cfbf861ac3` `Provisional database: SQLite, move to PostgreSQL on triggers` | `decision` | `proposed` | developer | file `docs/db-decision.md`, message `b560ca38`, run `8c0fcf3e` |
| `b244a807-2de8-4183-8348-0e5d8c29cf7d` `Conflicting database memories: Postgres vs provisional SQLite` | `known_issue` | `proposed` | developer (proposed by the summarizer on the run's behalf) | message `a241b9d2`, run `8c0fcf3e` twice |

The `known_issue` comes from the developer's context pack, which held two Playwright `E2E decision` entries ("Use Postgres for everything.", `f38bb30e`, `b2c4096d`). The file `docs/db-decision.md` in the sandbox is 1101 bytes, sha256 `740dc0b4296fdcab468966a76f8f3eadc5167e71dea4c5599e9bd6df97636b60`, uncommitted.

UI: `/conversations?taskId=e6ce39eb-...` showed the `Pick the database` thread with the architect's reply, the linked task `Done` and both participants. `/memory` listed the three entries with their sources (`docs/db-decision.md`, `architect reply`, `Run 8c0fcf3e`, `Task e6ce39eb`) and "2 entries need review". Both screenshots were taken after the restart below.

Expectations:

| Expectation | Result |
|---|---|
| developer run reaches `waiting_reply` with an `agent.waiting_reply` event | **not met**: the run suspended and resumed, but no `agent.waiting_reply` event exists; `ClaudeAdapter` does not emit it (`FakeAdapter` does) |
| inbox run for `architect`; `read_inbox` and `reply_message` visible as `agent.message.received` / `agent.message.sent` | met (seq 8, seq 16) |
| developer run resumes (`agent.resumed`), writes the file, calls `propose_memory`, task `done` | met (seq 15, 18, 21-22; task `done`) |
| summary run writes a verified `task_summary` with sources | met (`666ea1bc`, 2 sources) |
| Conversations page shows the thread | met |
| Project Memory lists the proposed decision with its sources | met (`32f129b5`, 3 sources) |
| after restarting the API and the worker, `GET /conversations/:id` and `GET /memory/:id` return everything | met (below) |
| a second task shows the summary id in its `contextPack` | met (below) |

Restart: at 07:20:34Z the API (tsx watch and its child) and the worker were killed by pid; port 4000 was closed. Both were started again with `.env` exported, and the worker logged `connected to API` at 07:20:49Z. With the same owner cookie, `GET /conversations/27251a71-...` returned both messages (`b560ca38` question from developer, 07:18:56.813Z; `a241b9d2` reply from architect, `inReplyToId` `b560ca38`, 07:19:12.251Z). `GET /memory/666ea1bc-...` returned `verified` with 2 sources and `GET /memory/32f129b5-...` returned `proposed` with 3 sources. `GET /memory?projectId=...` listed both. All three sessions were `succeeded` (closed).

Second task: `Say hello` (`developer`, description `Reply with one line: hello.`), task `c059d52a-4604-4600-8005-390d0a4c4dba`, created 07:21:31.853Z after the summary existed. Run `fa1a9cc2-244c-40cb-a01c-94c28f417882`, result `hello`, cost 0.0305653, task `done`. Its session `07d528d0-da52-4db6-909f-4d394fac93fd` has `contextPack` `{chars: 1358, entryIds: ["666ea1bc-..."], inboxCount: 5, summaryIds: ["666ea1bc-9764-4e76-859f-1e98e9818dde"]}`. Its own summary run `c0320bbe-fa0c-465b-a2db-af63a2f1f1d0` (cost 0.00181621) wrote `81c2059e-09d7-4fab-a08a-adee4aebdd86`.

Cost: 0.37474849 USD for the acceptance task (developer, architect inbox, summary) and 0.40712 USD with the second task and its summary.

After the acceptance, the Playwright suite's memory test verified `b244a807` (07:23:53Z) and `32f129b5` (07:25:25Z) through its "Review now" flow. No person reviewed them.

Worker log note: the SDK printed `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED` for the developer's built-ins and the `mcp__office__*` tools. For the summary run it named only `mcp__office__submit_summary`. The office tools are auto-approved like other allowed tools (see `docs/security.md`).

### Phase 3 acceptance, attempt 2 (real Claude)

Date: 2026-11-01, after bd3d78a (`ClaudeAdapter` emits `agent.waiting_reply` on suspend). The runtime `dist` was rebuilt and the worker restarted by pid; it logged `connected to API` at 07:34:36Z. Setup, driver and task text are the same as in attempt 1. One attempt, no retry. Result: **one expectation not met (see Verdict)**. `agent.waiting_reply` is now emitted and every other expectation held, but the developer did not write `docs/db-decision.md`. The file was still in the sandbox from attempt 1, because the implementer did not remove it before this attempt. The developer read it, found that it matched the architect's answer and left it unchanged (seq 21: "The file already matches the architect's answer, so I'll leave it unchanged and propose the memory."). Attempt 1 shows that the write path works with the same code (bd3d78a changes only the adapter's suspend event). The controller ruled on this (see "Verdict" below).

| Run | Kind | Agent | Run id | Session | Created | Finished | Cost (USD) |
|---|---|---|---|---|---|---|---|
| developer | `task` | developer (sonnet) | `da3afd0d-e67f-4578-9004-cded20b3d897` | `1a715d7d-f7b2-4175-857a-ee2bcc4b4d03` (SDK `720437b7-f585-4521-8fae-dcb20539a227`) | 07:35:18.267Z | 07:35:50.133Z | 0.1165953 |
| architect inbox | `inbox` | architect (sonnet) | `631751a4-3f61-401b-9fc0-3067ee63c80b` | `52f9ebb4-cf98-4e44-9e8c-b030e9c69955` (SDK `d1ab921b-c038-4266-9b5f-d127a6568046`) | 07:35:28.284Z | 07:35:43.000Z | 0.0522342 |
| summary | `summary` | office-summarizer (haiku) | `a9281ebc-5751-4cfb-baaf-30846c02232b` | `c2c0d264-b931-49ff-9d67-c4d5dc1568db` | 07:35:50.325Z | 07:36:02.468Z | 0.00314519 |

Task `da45cbe0-4563-422c-a97b-940f230680c7`: created 07:35:18.027Z. Polling every 10 s showed `waiting_reply` at 07:35:28Z and 07:35:38Z, `running` at 07:35:48Z and `done` at 07:35:58Z (`updatedAt` 07:35:50.137Z, attempts 1). Conversation `1fca4082-3599-4df0-a9d8-43ecaf99ebae` (kind `task`). The worker log shows `run assigned` for the developer run at 07:35:18Z and again at 07:35:40Z, with the architect's inbox run at 07:35:28Z in between.

Developer run events:

```
seq 10 agent.tool.started     07:35:25.276Z  mcp__office__list_agents
seq 12 agent.tool.started     07:35:26.860Z  mcp__office__send_message {to: architect, type: question, awaitReply: true}
seq 13 agent.message.sent     07:35:26.949Z  messageId 9bd4f5e8-e424-4d85-a80d-678073d86100, conversation 1fca4082-...
seq 14 agent.waiting_reply    07:35:26.949Z  {to: architect, messageId: 9bd4f5e8-...}
seq 15 agent.tool.completed   07:35:26.955Z  "Your turn ends now; ..."
seq 16 agent.resumed          07:35:40.295Z  {reason: reply, messageId: 7dc67838-20be-4760-b368-f14567d06b9b}
seq 17 agent.started          07:35:40.627Z
seq 18 agent.tool.started     07:35:42.339Z  Bash: cat docs/db-decision.md; git status --short
seq 21 agent.text             "The file already matches the architect's answer, so I'll leave it unchanged and propose the memory."
seq 22 agent.tool.started     07:35:45.597Z  mcp__office__propose_memory {type: decision}
seq 23 memory.proposed        07:35:45.627Z  entryId 729b7a3b-5246-4ac4-92c6-33a62de2cf74
seq 26 agent.completed        07:35:49.600Z  costUsd 0.0713506 (this segment), numTurns 3
```

Architect inbox run: seq 7 `read_inbox` (07:35:32.820Z), seq 8 `agent.message.received {count: 1}` (07:35:32.837Z), seq 15 `reply_message`, seq 16 `agent.message.sent {type: reply, messageId: 7dc67838-...}` (07:35:39.992Z), seq 19 `agent.completed` (8 turns). Its context pack: `{chars: 1683, entryIds: [666ea1bc, 81c2059e], inboxCount: 1, summaryIds: [81c2059e, 666ea1bc]}`.

Summary run: `submit_summary` (seq 6, 07:35:59.727Z) returned entry `f03b95b9-b8b4-439a-8192-32cb8a967e7b` and proposal `37c18e4c-9cfd-4652-981c-39f06d579f4c`.

| Entry | Type | Status | Sources |
|---|---|---|---|
| `f03b95b9-b8b4-439a-8192-32cb8a967e7b` `Summary: Pick the database` | `task_summary` | `verified` | run `da3afd0d`, task `da45cbe0` |
| `729b7a3b-5246-4ac4-92c6-33a62de2cf74` `Provisional database: SQLite, move to PostgreSQL on triggers` | `decision` | `proposed` | file `docs/db-decision.md`, message `9bd4f5e8`, run `da3afd0d` |
| `37c18e4c-9cfd-4652-981c-39f06d579f4c` `Database decision conflicts with verified Postgres memory` | `known_issue` | `proposed` | run `da3afd0d` (twice), task `da45cbe0`, message `7dc67838` |

Both proposals were still `proposed` after the fixed Playwright suite ran again (8 of 8).

UI (headless Chromium, after the restart): `/conversations?taskId=da45cbe0-...` showed the thread with the architect's reply, the linked task `Done` and both participants. `/memory` listed 14 entries with "2 entries need review" (the two proposals above, with their sources).

| Expectation | Result |
|---|---|
| developer run reaches `waiting_reply` with an `agent.waiting_reply` event | met (seq 14; task polled `waiting_reply`) |
| inbox run for `architect`; `agent.message.received` / `agent.message.sent` | met (seq 8, seq 16) |
| developer run resumes, writes the file, calls `propose_memory`, task `done` | **partly met**: resumed (seq 16), `propose_memory` (seq 22-23), task `done`; the file was not written because it already existed from attempt 1 |
| summary run writes a verified `task_summary` with sources | met (`f03b95b9`, 2 sources) |
| Conversations page shows the thread | met |
| Project Memory lists the proposed decision with its sources | met (`729b7a3b`, 3 sources) |
| after restarting the API and the worker, conversation and memory are returned | met (below) |
| a second task shows the summary id in its `contextPack` | met (below) |

Restart: at 07:36:47Z the API and the worker (pnpm, tsx watch and node processes) were killed by pid, and port 4000 closed. Both were started again; the worker logged `connected to API` at 07:36:59Z. `GET /conversations/1fca4082-...` returned both messages (`9bd4f5e8` question; `7dc67838` reply with `inReplyToId` `9bd4f5e8`). `GET /memory/f03b95b9-...` returned `verified` with 2 sources and `GET /memory/729b7a3b-...` returned `proposed` with 3 sources. The three sessions were `succeeded`, and the developer run's events still held `agent.waiting_reply` at seq 14.

Second task: `Say hello` `325ba285-12e0-439d-aa91-e9965e55ccf8`, created 07:37:15.440Z. Run `ba38d571-bca3-419a-acc1-e300157efa13`, result `hello`, cost 0.035326, task `done`. Its session `0774efd7-24ee-4858-8fad-cc2f2a0b19b1` has `contextPack.summaryIds` `["f03b95b9-b8b4-439a-8192-32cb8a967e7b", "81c2059e-...", "666ea1bc-..."]` (chars 4328, inboxCount 7). Its summary run was `640e1977-d234-41b5-8c7a-fc3dc797f681` (cost 0.00186363).

Cost: 0.17197469 USD for the attempt 2 chain (developer, architect inbox, summary), and 0.20916532 USD with the second task and its summary. Phase 3 acceptance total over both attempts: 0.61628532 USD.

Observation: the Project Memory detail pane labels a summarizer-written `task_summary` "Verified by you", although no owner verified it.

### Verdict

Phase 3 is `done` by controller ruling. The spec §17 Phase 3 acceptance (two agents exchange messages, finish, memory saved, sessions closed and reopened, history and memory retrievable with sources) holds across attempts 1 and 2. The two attempts ran the same code except for the adapter's suspend event. Attempt 1 proved the file write and the tool flow. Attempt 2 proved `agent.waiting_reply` and everything else. The file expectation was not met in attempt 2 because `docs/db-decision.md` already existed in the sandbox; this is a leftover-file artifact of the sandbox, not a defect. The owner may re-run the acceptance on a clean sandbox.

## Phase 2 decisions

- Pinned skills are materialized by the worker under `<OFFICE_WORKER_HOME>/runs/<runId>/.office/.claude/skills/<name>/`, passed to the SDK as an additional directory, and removed after the run; stale run roots are swept when the worker starts.
- Skills authored in the UI are `approved` on creation; imported skills (local directory or git) start as `pending_review` and must be approved before an agent can pin them.
- `AgentSkill` and `AgentSubagent` rows belong to an `AgentVersion` and are immutable with it; changing pins or subagents creates a new agent version.
- `ProjectAgent` is deferred to Phase 4 (the Chief's planning needs it; nothing in Phase 2 does).
- Skill frontmatter parsing supports single-line `key: value` only.

## Phase 2 evidence

### Runtime skill smoke

Date: 2026-10-31. Command: `pnpm --filter @office/runtime exec tsx scripts/smoke-skills.ts` (model `haiku`, `maxBudgetUsd` 0.05, `allowedTools: []`, one eager skill `office-smoke`, prompt `Follow your instructions.`, system prompt from `skillPromptSection`). First attempt, exit 0.

Layout that worked: `additionalDirectories` (no plugin fallback needed). The skill was written to `<mkdtemp>/.office/.claude/skills/office-smoke/SKILL.md` and `skillsDir = <mkdtemp>/.office` was passed as `additionalDirectories: [skillsDir]`, with the `skills: ['office-smoke']` filter. Task 6 materializes skills to `<skillsDir>/.claude/skills/<name>/`.

Result: `agent.started.slashCommands` lists `office-smoke` (bare name, no leading `/`); `agent.skill.invoked office-smoke` emitted; status `succeeded`; resultText `SKILL_OK`; costUsd 0.00484578.

Observations: `slashCommands` also lists built-in commands and other bundled skills, so the `skills` option does not narrow that list. The SDK prints a `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED` warning for `Skill`: a bare `allowedTools` entry auto-approves the tool before `canUseTool` runs, which is the intended grant when skills are pinned.

```
event agent.started {"slashCommands":["office-smoke","deep-research","design","design-sync","dataviz","update-config","verify","debug","code-review","simplify","batch","fewer-permission-prompts","doctor","loop","schedule","send-to-project","claude-api","workflow-authoring","run","run-skill-generator","plugin-authoring","advisor","agents","auto-mode-setup","autocompact","clear","color","compact","config","output-style","context","effort","fast","focus","heapdump","init","mcp","import","model","__remote-workflow","workflow-launch-exec","reload-plugins","reload-skills","rename","ultrareview","security-review","usage-credits","extra-usage","usage","insights","recap","skill-doctor","goal","design-consent","design-revoke","list-agents","team-onboarding"],"agents":["claude","Explore","general-purpose","Plan","statusline-setup"]}
event agent.tool.started Skill {"skill":"office-smoke"}
event agent.skill.invoked office-smoke
event agent.tool.completed
event agent.thinking
event agent.text
event agent.completed
result {
  "status": "succeeded",
  "resultText": "SKILL_OK",
  "sdkSessionId": "ef299388-a488-4ab5-8e9f-fade829c25e4",
  "usage": {
    "inputTokens": 4,
    "outputTokens": 184,
    "costUsd": 0.00484578,
    "numTurns": 3,
    "durationMs": 3676
  }
}
```

### Runtime subagent smoke

Date: 2026-10-31, after the acceptance run. Fix: `effectiveAllowedTools` in `packages/runtime/src/claude/adapter.ts` now adds both `Agent` and `Task` when subagents are pinned, so neither is in `disallowedTools`. Command: `pnpm --filter @office/runtime exec tsx scripts/smoke-subagent.ts` (model `haiku`, `maxBudgetUsd` 0.10, `allowedTools: []`, no skills, one subagent `echoer` (`Reply with exactly: SUBAGENT_OK`, model `haiku`), prompt `Use the echoer subagent and return exactly what it replies.`, system prompt `Delegate to the echoer subagent; do not answer yourself.`). The script passes when `agent.started.payload.tools` contains `Agent` or `Task`, an `agent.subagent.spawned` event is seen and the result contains `SUBAGENT_OK`.

Attempt 1 (2026-10-31T20:15:31Z) exited 1. The subagent worked (`agent.subagent.spawned`, `agent.subagent.completed` with summary `SUBAGENT_OK`, resultText `SUBAGENT_OK`, reported cost 0.006620055 USD), but the script's check then required `Agent` in `tools`, and the SDK lists the subagent tool there as `Task`. The check was changed to accept either name; the adapter was not changed.

Attempt 2 (2026-10-31T20:17:59Z), exit 0, check `{"subagentTool":true,"spawned":true}`:

```
[CLAUDE_SDK_CAN_USE_TOOL_SHADOWED] Warning: canUseTool will not be invoked for: Agent, Task. ...
event agent.started {"tools":["Task","AskUserQuestion","CronCreate","CronDelete","CronList","DesignSync","EnterPlanMode","EnterWorktree","ExitPlanMode","ExitWorktree","Glob","Grep","ListAgents","PushNotification","Read","RemoteTrigger","ReportFindings","ScheduleWakeup","SendMessage","SendToProject","SendToProjectContext","ToolSearch","Workflow"],"agents":["claude","echoer","Explore","general-purpose","Plan","statusline-setup"]}
event agent.tool.started Agent {"description":"Run echoer subagent","subagent_type":"echoer","prompt":"Echo request: reply with your response exactly as you would return it."}
event agent.subagent.spawned {"toolUseId":"toolu_012aDCcSEudcyD4z8Utj1HC9","description":"Run echoer subagent","subagentType":"echoer"}
event agent.tool.completed
event agent.thinking
event agent.text
event agent.completed {"resultText":"The echoer subagent is still running. I'll return its reply verbatim once it finishes.","costUsd":0.00188837,"numTurns":2,"durationMs":2597}
event agent.thinking
event agent.text
event agent.subagent.completed {"toolUseId":"toolu_012aDCcSEudcyD4z8Utj1HC9","status":"completed","summary":"SUBAGENT_OK"}
event agent.started {"tools":["Task", ... 106 mcp__claude_ai_* connector tools (Claude_Docs 8, Gmail 30, Notion 68) ...],"agents":[...same...]}
event agent.text
event agent.completed {"resultText":"SUBAGENT_OK","costUsd":0.00286565,"numTurns":1,"durationMs":720}
result {"status":"succeeded","resultText":"SUBAGENT_OK","sdkSessionId":"e4e357f8-cd95-47d5-91f8-6752c648dd82","usage":{"inputTokens":2,"outputTokens":12,"costUsd":0.00286565,"numTurns":1,"durationMs":720}}
check {"subagentTool":true,"spawned":true}
```

Cost: the result reports 0.00286565 USD, the full cost of the run. The run had two completions: the first (0.00188837 USD) ended while the subagent was still running, and the second came after the subagent's result. The adapter's `RunResult.usage` takes `total_cost_usd` from the last SDK result, and the SDK typings define it as cumulative (`SDKResultMessage.total_cost_usd`: each result carries the running total so far, so the latest result is read rather than summed).

Attempt 3 (2026-10-31T20:29:37Z), after the fix that always passes `mcp__*` in `disallowedTools`, exit 0, check `{"subagentTool":true,"spawned":true}`. Tools-list check: no `mcp__` name appears in either `agent.started.payload.tools` list (`grep -c mcp__` on the output: 0). The second list adds the built-in `ListMcpResourcesTool`, `ReadMcpResourceTool` and `ReadMcpResourceDirTool`, which are not `mcp__` tools; they are not in the allow list, so `canUseTool` denies them. Cost 0.00218026 USD (cumulative, per the note above).
Since e8ceb84 these three are in `BUILTIN_TOOLS` and therefore in `disallowedTools` unless allowed.

```
[CLAUDE_SDK_CAN_USE_TOOL_SHADOWED] Warning: canUseTool will not be invoked for: Agent, Task. ...
event agent.started {"tools":["Task","AskUserQuestion","CronCreate","CronDelete","CronList","DesignSync","EnterPlanMode","EnterWorktree","ExitPlanMode","ExitWorktree","Glob","Grep","ListAgents","PushNotification","Read","RemoteTrigger","ReportFindings","ScheduleWakeup","SendMessage","SendToProject","SendToProjectContext","ToolSearch","Workflow"],"agents":["claude","echoer","Explore","general-purpose","Plan","statusline-setup"]}
event agent.tool.started Agent {"description":"Run echoer subagent","subagent_type":"echoer","prompt":"Echo request: please reply with your standard echo response."}
event agent.subagent.spawned {"toolUseId":"toolu_0196QycRLu5WvRQdU2bFMXS5","description":"Run echoer subagent","subagentType":"echoer"}
event agent.tool.completed
event agent.text
event agent.text
event agent.completed {"resultText":"The echoer subagent is running in the background. I'll return its reply when it finishes.","costUsd":0.0011252599999999999,"numTurns":2,"durationMs":2212}
event agent.subagent.completed {"toolUseId":"toolu_0196QycRLu5WvRQdU2bFMXS5","status":"completed","summary":"SUBAGENT_OK"}
event agent.started {"tools":["Task","AskUserQuestion","CronCreate","CronDelete","CronList","DesignSync","EnterPlanMode","EnterWorktree","ExitPlanMode","ExitWorktree","Glob","Grep","ListAgents","ListMcpResourcesTool","PushNotification","Read","ReadMcpResourceDirTool","ReadMcpResourceTool","RemoteTrigger","ReportFindings","ScheduleWakeup","SendMessage","SendToProject","SendToProjectContext","ToolSearch","Workflow"],"agents":["claude","echoer","Explore","general-purpose","Plan","statusline-setup"]}
event agent.thinking
event agent.text
event agent.completed {"resultText":"SUBAGENT_OK","costUsd":0.00218026,"numTurns":1,"durationMs":988}
result {"status":"succeeded","resultText":"SUBAGENT_OK","sdkSessionId":"3548a096-dd56-431f-9711-d47f04d58f3f","usage":{"inputTokens":2,"outputTokens":90,"costUsd":0.00218026,"numTurns":1,"durationMs":988}}
check {"subagentTool":true,"spawned":true}
```

Observations: in both attempts, a second `agent.started`/`agent.completed` pair appeared after the first completion. The second `agent.started` listed the machine's claude.ai MCP connector tools (`mcp__claude_ai_Gmail__*`, `mcp__claude_ai_Notion__*`, `mcp__claude_ai_Claude_Docs__*`); the first did not. No connector tool was called. They come from the machine's claude.ai login; since 6fbcd89 the adapter passes `mcp__*` in `disallowedTools`, and attempt 3 listed no `mcp__` tool.

### Phase 2 acceptance (real Claude)

Date: 2026-10-31. Result: **passed**. One attempt per task, no retry. Every expectation held for both runs: the pinned skill names are in `agent.started.payload.slashCommands`, at least one eager pin produced `agent.skill.invoked`, each `session.skillsSnapshot` equals its agent version's pins and the two snapshots differ, and both tasks reached `done`.

Setup: infra already up; `pnpm --filter @office/shared build && pnpm --filter @office/db build && pnpm --filter @office/runtime build`; `pnpm seed` printed `exists` for the project, the 12 skills and the 5 agents. API (`pnpm --filter @office/api dev`), worker (`OFFICE_RUNTIME=claude pnpm --filter @office/worker dev`, worker `e973b79e-8611-4552-b949-b291d5fd493e`, reconnected with its saved credential) and web (`pnpm --filter @office/web dev`) were started with the root `.env` exported. The worker used the machine's Claude Code login. Project `office-sandbox` `e844090c-2a16-4a62-a199-a251103a8736`, repository `/home/meren/projects/office-workspaces/office-sandbox` (it held only the Phase 1 `hello.txt` before the runs).

Driver: the implementer had no browser, so Agent Studio's save was done with the same API call it makes (`PUT /agents/:id`), tasks were submitted with `POST /tasks`, and progress was read by polling `GET /tasks/:id` every 3 s, then `GET /runs/:id`, `GET /runs/:id/events` and `GET /runs/:id/subagents` (cookie session of the owner account). The visual click-through remains for the owner (see Outstanding).

Agent versions:

- `developer` `15e9d1b8-65b4-4350-96ca-067db9315e9d`: `PUT /agents/:id` with the version 1 config plus `skills: [{ test-driven-development, eager }, { lazy-expert-developer, eager }]` and no subagents created version 2, `f1581cc8-a858-4f86-91ea-6405817bcbec` (model `sonnet`, 30 turns, budget 1 USD, tools Read, Glob, Grep, Bash, Edit, Write), with two pins.
- `designer` `5397e684-03e4-40d3-b533-30eac6b952e2`: seeded version 1, `464cdc9a-bda7-45ba-9b02-d92e3e97c9d4` (model `sonnet`, budget 1 USD), `frontend-design` eager, `accessibility`, `design-systems`, `responsive-design`, `ui-ux-design`, `visual-quality-review` on demand, subagents `ux-researcher`, `accessibility-reviewer`, `visual-reviewer`.

| Task | Agent | Task id | Run | Session | SDK session | Events | Cost (USD) | Task status |
|---|---|---|---|---|---|---|---|---|
| `Add a sum helper` | developer v2 | `df321e0f-d732-4ec1-8496-815888f913d1` | `749f2d1a-2fca-4054-a261-89d13a887020` | `22f71055-0a90-4ea2-a720-7e1d37a10705` | `d2f8ec21-a9a3-4973-a7a2-324d43ac5b45` | 27 | 0.1411956 | done |
| `Landing page` | designer v1 | `fc25d794-8650-4c02-b8f4-70667690d7ac` | `d23801ca-6a49-44f7-9179-82b9629d59b0` | `8f0c0c4f-1047-4029-9097-3be7ad8982b3` | `178b104b-4453-4586-8e6f-e2831fb9dd9c` | 13 | 0.0892959 | done |

Total cost 0.2304915 USD. Descriptions, verbatim: `Create sum.js exporting function sum(a, b) and a test file sum.test.js using node:test that checks sum(2, 3) === 5; run the test with node --test and show the output.` and `Create index.html with a responsive hero section for "Agent Office" using only inline CSS; keep it accessible.`

Developer run (started 2026-10-31T20:05:04.191Z, finished 20:05:15.346Z, status `succeeded`, 10 turns):

```
seq 1  agent.started        2026-10-31T20:05:04.499Z  model claude-sonnet-5-5
seq 2  agent.tool.started   Skill {"skill":"lazy-expert-developer"}
seq 3  agent.skill.invoked  2026-10-31T20:05:06.353Z  lazy-expert-developer
seq 5  agent.tool.started   Skill {"skill":"test-driven-development"}
seq 6  agent.skill.invoked  2026-10-31T20:05:06.757Z  test-driven-development
seq 12 agent.text           "Red step first: I'll write the test before `sum.js` exists."
seq 13 agent.tool.started   Write sum.test.js            seq 14 agent.file.changed sum.test.js
seq 16 agent.tool.started   Bash node --test 2>&1 | head -30   (fails: Cannot find module './sum')
seq 20 agent.tool.started   Write sum.js                 seq 21 agent.file.changed sum.js
seq 23 agent.tool.started   Bash node --test 2>&1        seq 25 "✔ sum(2, 3) === 5 ... pass 1, fail 0"
seq 27 agent.completed      2026-10-31T20:05:14.808Z  costUsd 0.1411956, numTurns 10
```

Designer run (started 2026-10-31T20:05:30.242Z, finished 20:05:54.492Z, status `succeeded`, 5 turns):

```
seq 1  agent.started        2026-10-31T20:05:30.501Z  model claude-sonnet-5-5
seq 2  agent.tool.started   Skill {"skill":"frontend-design"}
seq 3  agent.skill.invoked  2026-10-31T20:05:32.482Z  frontend-design
seq 5  agent.tool.started   Bash ls -A && git log --oneline | head -5
seq 9  agent.tool.started   Write index.html             seq 10 agent.file.changed index.html
seq 13 agent.completed      2026-10-31T20:05:54.070Z  costUsd 0.0892959, numTurns 5
```

The designer invoked only its eager skill and none of the five on-demand skills. It could not use its subagents: the subagent tool was missing from the session (see the worker log note below).

`slashCommands` in `agent.started`: the developer run's list (58 entries) starts with `lazy-expert-developer`, `test-driven-development`; the designer run's list (62 entries) starts with `accessibility`, `design-systems`, `frontend-design`, `responsive-design`, `ui-ux-design`, `visual-quality-review`. The rest of each list is built-in commands and bundled skills, as in the runtime smoke. `agent.started.payload.agents` for the designer run lists `accessibility-reviewer`, `ux-researcher` and `visual-reviewer` next to the built-in agents; the developer run lists only built-ins.

`session.skillsSnapshot` (from `GET /runs/:id`), developer:

```json
[{"mode":"eager","name":"lazy-expert-developer","skillId":"41f4bf5b-2ef0-4fa3-a2b4-258970c3942b","version":1,"checksum":"b1b29155101e6c00ee236f81b951b6027ba3ce0a4b19d176b4c5d3ed1435d894","skillVersionId":"298d9144-6913-4b04-9e7c-0c565636d02e"},
 {"mode":"eager","name":"test-driven-development","skillId":"884f98d0-69e6-44f2-88d9-8a89415a7460","version":1,"checksum":"5537e3f2a42f51459311e026c75e055efc14acf1a253a18f8d01b7d6636a5abe","skillVersionId":"103536c6-8b61-4d09-ac02-54bf3bc58cbb"}]
```

Designer:

```json
[{"mode":"on_demand","name":"accessibility","skillId":"1536ad40-704a-459f-9523-2091bfacb7be","version":1,"checksum":"11269c06321ac6e58740277703152adfe1c9092c265f5e7fde83ff6836bdb0a6","skillVersionId":"64d82660-5ded-4e6f-a05d-f27055b36d97"},
 {"mode":"on_demand","name":"design-systems","skillId":"02511258-2292-4542-a010-11f30cedff62","version":1,"checksum":"7bf3860a34a186ebd2ff104dadfcad82df5f88130b45689bd240a34e522dd96b","skillVersionId":"0a622751-7952-4902-b9d1-b3f16efbd506"},
 {"mode":"eager","name":"frontend-design","skillId":"399a2c50-711f-4a32-a8aa-2959b4fbf9f6","version":1,"checksum":"90ecdab3cb88caa43128f573a1e332c7fe6f7d6369c8ab60c88a591f44d6fbd4","skillVersionId":"f3778962-57f0-4b32-9654-807577af0d54"},
 {"mode":"on_demand","name":"responsive-design","skillId":"18bb1c4b-9313-4e98-8579-12abbad5f56f","version":1,"checksum":"786f2b2cc8a847dfde56c6d22294c59779b4a94bbe60d697e7f7608a6fce9aa3","skillVersionId":"d69628d9-b823-49a4-845b-0e01a71eacaf"},
 {"mode":"on_demand","name":"ui-ux-design","skillId":"9b7e8e30-da6d-4bd1-837a-d0e0ae756d13","version":1,"checksum":"ae656cf461a05920ce331f133449c897ef445dfb8c33bb6629abbe76e4a32662","skillVersionId":"1636d2be-88a2-4c93-8181-2b037050d78d"},
 {"mode":"on_demand","name":"visual-quality-review","skillId":"3ed34bc9-0fb3-4949-b847-772d959cca83","version":1,"checksum":"916b4946ed86c4c30d0af95f40cf2dc8bc986b8f920bea48cecd4e7df0d64c7e","skillVersionId":"18d955b2-ec70-4b27-a1f3-22120e405bba"}]
```

Each snapshot's `skillId`, `skillVersionId`, `name`, `version` and `mode` match the pins of its agent version (`GET /agents/:id` `currentVersion.skills`), and each `checksum` matches the pinned `SkillVersion` (`GET /skills/:id` `currentVersion.checksum`).

`GET /runs/:id/subagents`: `[]` for both runs.

Files in the sandbox after both runs (left in place, uncommitted):

```
$ ls -la /home/meren/projects/office-workspaces/office-sandbox
-rw-r--r-- 24   hello.txt     (Phase 1)
-rw-r--r-- 5410 index.html    (designer run)
-rw-r--r-- 66   sum.js        (developer run)
-rw-r--r-- 181  sum.test.js   (developer run)
$ sha256sum *
ec3c94d325c2638a2448fb45ceb38bab0083cf8399ebc8ca6aaccfb3e7762ad2  hello.txt
f83d15980960bc0a82fc90accb56254a0dcdc263c642fa120a79e524765dd126  index.html
902f34f2ae20a060b53c1b271500fce4e4b80af9f86b95a15c0d3b7a7b443f16  sum.js
87926306be79f5ef445eecff4fe511f3d648c4b3a4291d8f697da4601ecc2ddf  sum.test.js
```

Running `node --test` in the sandbox independently after the run: tests 1, pass 1, fail 0.

Run roots: after both runs `/home/meren/.office-worker/runs` was empty, so the materialized skills were removed.

Replay after restart: the API process was killed (health check failed) and restarted at 2026-10-31T20:06:28Z. `GET /runs/:id/events` returned the same `(seq, type)` lists as before the restart (developer seqs 1 to 27, designer seqs 1 to 13; SHA-256 of the lists identical before and after). Both tasks still returned `done`; the worker reconnected by itself and was `online`.

Web pages (Next.js dev server, owner cookie): `GET /`, `/skills`, `/skills/884f98d0-69e6-44f2-88d9-8a89415a7460`, `/agents`, `/agents/15e9d1b8-65b4-4350-96ca-067db9315e9d`, `/tasks/df321e0f-d732-4ec1-8496-815888f913d1` and `/tasks/fc25d794-8650-4c02-b8f4-70667690d7ac` all returned HTTP 200.

Worker log note: the SDK printed `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED` for `Read, Glob, Grep, Bash, Edit, Write, Skill` (developer run) and for `Read, Glob, Grep, Bash, Edit, Write, Skill, Agent` (designer run), confirming that `Skill` and `Agent` are added to the allowed tools only when skills or subagents are pinned (see `docs/security.md`). The `tools` list in `agent.started` contains `Skill` for both runs, and neither `Agent` nor `Task`. The cause: the adapter added `Agent` to the allowed tools but left `Task` in `disallowedTools`, and the SDK lists the subagent tool as `Task` in a session's tools (calling it `Agent` in tool calls), so the designer session had no subagent tool. Fixed after this run; see "Runtime subagent smoke".

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

## Post-Phase 6 hardening (2026-11-02)

Owner request: "finish everything that is missing". Done, each on `main`:
- Greenfield projects (`POST /projects` without `repoPath`), `PUT`/`DELETE /projects/:id`, project switcher in the header with a new-project dialog, project card in Settings.
- Worktree confinement: file tools gated to the worktree and skills dir; Bash in the SDK sandbox (bubblewrap, `failIfUnavailable: false`, writes limited to the worktree, `spec.gitDir`, skills dir, temp dir and package caches). Chat, inbox and non-mission task runs are still unconfined (no worktree).
- Approval detection: `git push` after global options and with any whitespace; destructive patterns matched on the whitespace-normalized command; the read-only Bash heuristic denies file writers, inline interpreters (`eval`, `source`, `.`), package installs, any redirection and `git --output`.
- "Interrupt and send": `POST /runs/:id/interrupt`, `run.interrupt` worker message, adapter `suspended` result, scheduler resume with the owner's message; session page button.
- Skill on/off (`disabled` status, not materialized), stale review decisions refused, plan and review runs under the budgets, one gate decision without `toolUseId`, pending daily-budget approvals expire on a settings change, `review → cancelled` on mission cancel, finished missions refuse `PUT`, a skipped check satisfies the code evidence rule (greenfield), `OFFICE_DATA_DIR` absolute, redaction before capping, half-made worktrees removed.

Still not built (reasons): interactive PTY shell (new native dependency and a remote shell on the worker host; ask for it explicitly), `ProjectMember` (contradicts the single-owner decision), session Pause (the SDK has interrupt, not pause; "Interrupt and send" covers the use), messages to a subagent (reached through the parent), semantic memory search (needs an embedding provider and key), Claude Code plugins (request not clarified), the check grandchild that leaves its process group, the 7-day worktree sweep versus a run suspended longer than `replyTimeoutMinutes` (cannot happen with the default 60 minutes).

## Network allowlist and blocked review decision (2026-11-04)

Trigger: the first mission on the desktop app (redesign of maratus.co) failed in its first task. The sandbox denied `curl https://maratus.co/` (`deny network-outbound maratus.co:443 (user denied)`), the worker stopped without inventing content, the Chief reopened once, the retry failed the same way, and at `attempts 2/2` the Chief marked the task failed and the mission with it. Owner: the Chief should have reported the blocker and waited.

- Project setting `networkAllowedDomains` (Settings, "Network allowed domains"; `example.com` or `*.example.com`) is passed on `RunSpec` and becomes `sandbox.network.allowedDomains` for worktree runs; empty keeps the sandbox offline. The adapter test covers both.
- Same day, owner: "this should be the default in every project". The SDK sandbox has no allow-every-host option and refuses `*` ("Overly broad patterns like \"*.com\" or \"*\" are not allowed"), so a new setting `networkAccess` was added: `open` (default) runs worktree Bash without the sandbox (file-tool gate, read-only heuristic and approval policy still apply); `allowlist` keeps the sandbox with `networkAllowedDomains`. Trade-off recorded in `docs/security.md`.
- `review_task` decision `blocked` (Chief only, note required): the task stays `review` with the note, no attempt is used, audit `task.reviewed` with `decision: blocked`; the mission stays `review` with its review run. The overview `attention` list gains `task_decision` rows for tasks still in review after a finished review run (blocked or left undecided), linking to the task page where the owner reopens or fails them. The review prompt tells the Chief to decide `blocked` instead of reopening a task that would fail the same way. Orchestration test: blocked -> attention -> owner reopen -> mission running.

## Unified sessions, Phase 1: external Claude Code sessions (2026-11-04)

Owner request: see the Claude Code sessions started from a terminal (any folder under the workspace roots, registered as a project or not), next to Office's own sessions, and resume them without re-explaining. Design in `docs/superpowers/specs/2026-11-04-unified-sessions-design.md` (four phases; Phase 1 built, no migration, local worker only):
- Protocol: `sessions.request { requestId, query }` / `sessions.response`; the worker answers from the SDK (`listSessions({ includeProgrammatic: false })`, `getSessionMessages`) and `claude agents --json` (`live`, 5 s timeout, nothing guessed from file times), filtering every `cwd` and `dir` to its real workspace roots. `open` spawns `$TERMINAL` or the first installed emulator (`kitty`, `alacritty`, `wezterm`, `ghostty`, `foot`, `konsole`, `gnome-terminal`, `xterm`, `x-terminal-emulator`) with `claude --resume <id>` as argv in the session's folder; refused `session_live` while the CLI still runs the session, `no_terminal` without a display or emulator.
- API: `WorkerGateway.requestSessions()` (a worker with the API's `machineId`, 10 s, `503 no_local_worker`, `503 worker_disconnected`, `504 worker_timeout`; worker errors map to 400/409/502). Routes `GET /claude-sessions` (`{ sessions, unavailable? }`: joined with projects by `repoPath`, Office's own `AgentSession.sdkSessionId` removed; without a local worker an empty list with `unavailable` set, since that is a normal state), `GET /claude-sessions/:id/messages?dir&offset&limit`, `POST /claude-sessions/:id/open { dir }`.
- Web: the Live Sessions page gains a "Claude CLI" card under the agent list, grouped by project (the selected one first) and "Unregistered · <folder>" with "Add as project" (opens the project form prefilled); selecting a session shows the read-only transcript (`useInfiniteQuery`, "Load more"), folder, branch, dates, "Open in terminal" (disabled while live) and "Copy command". No message box for external sessions.
- Tests: `apps/worker/test/sessions.test.ts` (roots and symlinks, transcript reduction and paging, live refusal, terminal errors), `apps/api/test/claude-sessions.test.ts` (project join, error mapping, no local worker, worker drop). Verified on the owner's machine with the real SDK and CLI: 66 sessions listed under `/home/meren/projects`, the running session flagged live and refused for `open`, `/etc` refused.
- Not built (later phases): Office-managed manual sessions with a PTY, background-agent attach, handoffs to and from missions, remote workers, transcript search.

## Unified sessions: manual session rows and the owner's room (2026-11-04)

The two leftovers after Phase 4:
- `ManualSession` table (migration `20261104142521_manual_sessions`; the generated SQL's drift noise about the generated `MemoryEntry.search` column was removed by hand): `TerminalRegistry` upserts a row on `terminal.opened` and on exit (writes of one terminal queued in order, since Prisma queries run only when awaited; `void prisma.x()` runs nothing), deletes it when an exited terminal is dismissed, and `load()`s every row at API start (`onReady`). A loaded `running` row stays running until its worker re-announces it (`seenAt`) or, on the worker's first heartbeat after connecting, is marked exited (`markStale(workerId, connectedAt)`). Scrollback is not persisted.
- Pixel Office: a last room "You" (`ownerRoom`, slug `owner`, couch theme, its own sprite) shows the project's running manual sessions and background sessions as creatures at desks, the header counts "N yours", and the right panel (`OfficeOwnerPanel`) lists them with links to `/sessions?terminal=` and `?session=`. Dashboard already counts manual sessions.

## Unified sessions, Phase 4: handoffs (2026-11-04)

- Session → Mission: "Start a mission from this" on a Claude session's transcript writes a draft request (`draftFromTranscript`: title, a line naming the session and folder, the newest turns trimmed to 600 characters each and 6000 in all; no model call) to `sessionStorage` and opens Mission Control, where the composer shows it until the owner edits or sends it (`useMissionDraft`, `clearMissionDraft` on send). The CLI session is never handed to the Chief; the owner's edited words are the request.
- Mission → manual session: "Open a manual session here" on a done, failed or cancelled mission starts an Office terminal on the project (`POST /terminals { projectId }`) and opens `/sessions?terminal=<id>&mission=<id>`; the terminal page shows the mission card (title, status, branch, summary or request, "Copy summary") with the note that the mission's work is on its branch while the terminal is on the checkout. `MissionSummary` now carries `projectId`. `TerminalDetail` links to the Claude transcript of its session.
- Double resume with Office on both sides: an Office terminal's `claude` is an interactive session the CLI lists, so a second resume of it anywhere is refused; forks pass.
- Tests: `apps/web/src/lib/mission-draft.test.ts`; Playwright 19/19 with both handoffs (draft lands in the composer; the done-mission fixture opens a terminal with the mission card).

## Unified sessions: gaps closed and Phase 3, background agents (2026-11-04)

Owner: "finish what is missing, then Phases 3 and 4". Closed from the Phase 1 and 2 gap list:
- Desktop: `apps/desktop/scripts/bundle.sh` rebuilds `node-pty` with `node-gyp rebuild --target=<electron> --dist-url=https://electronjs.org/headers` inside the deployed server bundle and fails the bundle unless it loads under `ELECTRON_RUN_AS_NODE=1 electron` (verified by hand on a copy: Electron 45.2.1, ABI 150, spawns a shell).
- Worker: terminal output produced while the API is unreachable is kept (256 KB per terminal) and flushed after the `terminal.opened` re-announce; `claude agents --json --all` (finished background sessions included), warned about once when the CLI lacks it; `claudeArgs`: `--session-id`, `--resume`, `--resume … --fork-session --session-id <new>`, `attach <id>`; `sessions.request` `background` start/stop/rm through `runClaude` (worker env minus Office's).
- API: `GET /claude-sessions` asks every connected worker with workspace roots (`sessionWorkers()`), rows carry `workerId`/`workerName`, a remote clone is joined with its project by `/repos/<projectId>`, `unavailable: worker_failed:<names>` when one does not answer; `messages`/`open`/`POST /terminals` take `workerId`; `POST /terminals { fork, attachId }`; keyboard control per terminal (`takeControl`, `terminal.control` on `/ws/ui`, subscribing takes it, `terminal.control` client message takes it back, keystrokes from other sockets dropped); overview `manualSessions`; `POST /claude-sessions/background` and `/background/:id/stop|rm` (audit `background.started|stopped|removed`). Fixed on the way: a disconnected worker id compared `undefined === undefined` and was treated as connected.
- Web: search box and type filter (All / Running / Manual / External / Background) on the Claude CLI card, worker name on rows when several workers answer, "bg · <state>" badges, "Fork here", "Attach here" / "Stop" / "Remove" for background sessions, "Background…" prompt dialog, "Take control" overlay, full-screen terminal, `?terminal=` and `?session=` deep links, the open session row re-read from the latest list, "Running sessions" KPI shows "· N manual".
- Tests: worker 11 session/terminal tests (buffering, argv, fork refusal rules, `$TERMINAL` spawn argv, background commands), API 6 (fan-out and remote join, control hand-over, fork/attach, worker offline, background audit), shared protocol parse test (caught a duplicate `background` discriminator that broke every worker message), Playwright 19/19 including an opt-in real terminal run (`OFFICE_E2E_REAL_TERMINAL=1`: a real `claude` starts in the Office terminal, Ctrl+C ends it, Dismiss removes it). The background lifecycle was exercised by hand against the CLI (`--bg`, `agents --json --all`, `logs`, `stop`, `rm`).
- Still in memory only: exited manual sessions (the Claude session itself stays in the Phase 1 list).

## Unified sessions, Phase 2: manual sessions inside Office (2026-11-04)

Built right after Phase 1, same branch family: "New manual session" on a project (or "Resume here" on an external session) runs the owner's own `claude` under a PTY on the local worker and shows it in an xterm.js terminal on the Live Sessions page.
- Worker `TerminalManager` (`node-pty`, loaded on first use): `terminal.open/input/resize/close` down, `terminal.opened/output/exit/error` up; `dir` under the roots, resume refused while `claude agents --json` lists the session; env passed through minus `OFFICE_*`, `DATABASE_URL*`, `COOKIE_SECRET`, `REDIS_URL` (so `CLAUDE.md`, plugins and skills are the owner's); SIGHUP then SIGKILL after 5 s; every terminal killed on worker stop; live terminals re-announced after every `welcome`.
- API `TerminalRegistry` (in memory): `POST /terminals` (201 once `terminal.opened` arrives; 503/409/400 mapped), `GET /terminals`, `DELETE /terminals/:id`; 256 KB scrollback per terminal; a gone worker ends its terminals; audit `terminal.opened` / `terminal.closed`. `/ws/ui`: `terminal:<id>` subscribe replays the scrollback then streams, `terminal.input` (64 KB cap) and `terminal.resize` go to the worker, `terminal.changed` on `global`.
- Web: "Manual sessions in Office" group, "New manual session", `TerminalDetail` (Stop with confirm, Dismiss), `OfficeTerminal` (xterm, fit addon, browser-only import). A finished manual session appears in the Phase 1 list by its pre-generated session id and can be resumed again.
- Tests: `apps/worker/test/terminals.test.ts` (real PTY with `/bin/sh`: output, input, env stripping, exit code, refusals, SIGHUP close, re-announce), `apps/api/test/terminals.test.ts` (open on the project repo, scrollback replay and live output over `/ws/ui`, input and resize forwarded, stop, forget, audit; refusals, re-adoption after an API restart, worker loss). Verified for real through the UI with Playwright: a `claude` TUI came up in the Office terminal (its folder-trust prompt), keystrokes reached it and its exit was shown; full suite 18/18.
- Not built: `node-pty` rebuilt for the desktop app's Electron Node (the bundled worker answers `spawn_failed` until then), output buffering on the worker while disconnected, Phase 3 (background agents) and Phase 4 (handoffs).

## Owner defaults and UI polish (2026-11-04)

- Project defaults: approval policy `auto` for every gate (`AUTO_APPROVAL_POLICY`), `dailyBudgetUsd` 1000, new `defaultMissionBudgetUsd` 5000 applied to missions created without a budget (Settings "Default per mission", composer chip). Tests that drive approval flows now set `ask` explicitly.
- In-app confirmations: `ConfirmProvider` + `useConfirm` replace every `window.confirm` (mission cancel, session stop, skill/project/memory delete, worker revoke, "Verify all"), so Electron no longer shows its native dialog.
- Agent Studio: "New agent" opens the form in a dialog; the Dashboard's "Create agent" links to `/agents?new=1`.
- Playwright 16/16 (the Stop test clicks the in-app dialog).

## Auto-commit and rebase before integration (2026-11-04)

The scaffold task of the maratus mission failed at 3/2 attempts for two platform reasons: in two runs the agent finished without `git commit` (the worktree was discarded with the work), and in the third the parallel design task had fast-forwarded the mission branch meanwhile, so the scaffold commit ended `needs_integration` and the Chief asked the owner to merge by hand. Fix in the worker (`finishWorktree`): leftover changes are committed as `Office auto-commit: changes <agent> left uncommitted` (build output excluded by name), then the run branch is rebased onto the mission head (`rebaseOnto`; on a clone after `git fetch office <mission>`), and only then checked and fast-forwarded; a conflicting rebase is aborted and reported as `agent.integration.failed`. The code-task prompt now says to commit and to keep build output out of git. Worker tests: `commitLeftovers`/`rebaseOnto` unit tests, the stale-base e2e and executor tests now expect `fast_forwarded`.

## Decisions page and mission status lines (2026-11-04)

Owner: the pending decisions were hard to find, nav counts appeared only after visiting a page, "Needs your attention" rows opened an unclear page, and a mission's state (stalled? cancelled?) was unreadable.

- `/decisions` (nav item after Dashboard, amber badge = overview `attention` count): plans to approve (Review plan / Approve / Deny), tool requests (`ApprovalCard`, "Approve all once"), tasks waiting for a decision (Chief's note, Reopen / Mark done / Failed, link into Mission Control), skill imports ("Approve all"), memory proposals (Verify / Reject, "Verify all"). "Verify all" at the top runs the three safe groups after a confirm; plans and task decisions stay individual.
- Overview `attention` gains `memory_proposal` rows and `missionId` on `task_decision` rows. Dashboard rows link to `/decisions` (approvals keep inline Approve/Deny); new Dashboard "Missions" card with one status sentence per open mission.
- `missionStatusLine` turns status + task counts into "Waiting for you: …" / "Running: 1 task active, 2 waiting…" / "Chief is reviewing…" / "Failed: …"; shown on PlanCard (amber when the owner's turn) and the Dashboard.
- Nav badges subscribe to the `global` hub topic and invalidate the affected queries; Mission Control's badge now counts open missions (live tone), Decisions carries the amber count.
- Mission Control accepts `?mission=<id>&task=<id>`; Playwright 16/16 against the dev stack (the dashboard assertion now expects the "Decide" link).

## Pixel Office (2026-11-02)

Owner request: implement option 3a of the "Pixel Office" design ("Temalı cozy kat"). Built on `main`:
- `/office` page (nav item "Office" after Live Sessions): header counts (running, need approval, waiting for reply, subagents) and a live clock; the isometric floor in a glass card with the legend; the right column with Approvals (approve once / deny / approve all, agent resolved from the approval's run) and the selected agent's panel (worker, run, status, task, elapsed, cost, subagents; Events from the project activity filtered by agent, Commands and Files from the run's session detail; links to Live Sessions and Conversations).
- Floor: 300×260 rooms on a 430×390 grid, three per row, the floor sized by the number of rows and scaled to the card width; CSS 3D (`rotateX(60deg) rotateZ(45deg)`), overlays placed with the same projection (`projector` in `apps/web/src/lib/office.ts`, unit-tested). Themes by role: chief → library, architect → aquarium, designer → garden, developer/frontend/backend → couch, qa → cork board and beanbag, summarizer → fireplace and cat; other roles get the plain cozy room. Pixel-art creatures are painted with the agent's gradient; subagents sit at mini desks in front, finished ones fade.
- Status language from `statusTone`: live typing dots and keyboard flicker, amber `!` for `waiting_approval`, `?` for `waiting_reply`, `zzz` and a desaturated sprite for idle.

Added the same day on the owner's request: speech bubbles (the agent's latest `agent.text` from the live `project:` topic or the stored activity, or its last sent message, one line) and envelopes between rooms (live `message.created` on `global`, 3.2 s per delivery; a `waiting_reply` run's question stays in flight, for which the live session list now carries `waitingFor` with the message id, body and recipient agent ids). Bubbles and envelopes are display only; status still comes from records. Idle rooms show no bubble.

Not built from the design: the List and Timeline views (Live Sessions and Activity cover them), "Open inspector" preselecting the run (the sessions page has no deep link). Verified with a mocked preview screenshot at 1980×1080; Playwright still not run (no `OFFICE_E2E_*` credentials), `/office` was added to its static page list.

## Desktop app (2026-11-03)

Owner request: run the whole thing as one Linux desktop application instead of separate services. Built on `main` as `apps/desktop` (Electron 45, AppImage via electron-builder) plus `apps/desktop/server` (`@office/desktop-server`, the runtime bundle: `@office/api`, `@office/worker`, `@office/db`, `pg`, `@embedded-postgres/linux-x64` 17.11):
- `scripts/bundle.sh` builds the packages, the web app as a Next.js standalone server (`OFFICE_DESKTOP_BUILD=1` turns on `output: 'standalone'` in `apps/web/next.config.ts`, `NEXT_PUBLIC_API_URL=http://127.0.0.1:4100`), and `pnpm deploy --legacy --prod --config.node-linker=hoisted` of the server bundle into `apps/desktop/build` (symlink-free, about 830 MB: the Claude Agent SDK binary, Prisma and Postgres are the bulk); templates are copied along.
- `src/main.ts` (Electron main) runs everything with Electron's own Node (`ELECTRON_RUN_AS_NODE=1`, Node 24): `initdb` once (user `office`, scram password kept 0600), `pg_ctl -w start` with TCP only (`unix_socket_directories=''`: a socket path under a long home directory exceeds 107 bytes), `boot.mjs`, then the API (4100), the web server (3100) and the worker (enroll token from `boot.mjs` on first run, credential kept in `worker/credentials.json`); the window opens once `/health` and the web server answer. `before-quit`, SIGINT and SIGTERM kill the children and `pg_ctl stop -m fast`; a child exiting while the app is up shows an error box with the log directory and quits.
- `boot.mjs` replaces `prisma migrate deploy` without shipping the Prisma CLI: it applies each `migration.sql` as one multi-statement query and records it in `_prisma_migrations` with the same sha256 checksum, so `prisma migrate status` agrees; then `seed()` with the bundled templates and, when the worker has no credential, a `pending` worker row named `desktop` with a fresh enroll token (stale pending `desktop` rows are deleted first).
- pgvector is not in the Postgres binaries; `apps/desktop/pgstub` ships a `vector` extension stub (text-backed base type with a typmod) copied into the bundle's `share/postgresql/extension`, so the Phase 3 migration applies unchanged. The `embedding` column is unused (keyword search only), so nothing reads it; replace the stub with real pgvector before any vector query.
- Redis was never used by code (the Phase 1 plan reserved it for the bus; everything went to Postgres and in-process gateways); it stays in `infra/compose.yaml` for the dev setup only and is not part of the desktop app.

Verified: `boot.mjs` against a fresh embedded cluster (10 migrations, seed, enroll token; second run idempotent), the bundle's API, web server and worker with the system Node (health ok, worker enrolled and connected), the unpackaged Electron app headless (`--ozone-platform=headless`: window title "Office" loaded, worker connected, SIGTERM stopped the children and Postgres), web typecheck and lint, desktop typecheck, and the packaged app itself: `release/office-0.1.0.AppImage` (421 MB; electron-builder drops a root-level `node_modules` of an `extraResources` entry, so the whole `build` directory is one entry) extracted with `--appimage-extract` (the host has no `libfuse.so.2`) and run headless with the same result. Not verified: the window on a real display (the agent's shell cannot reach the Wayland/X session), an agent run from inside the AppImage (Claude login, bubblewrap and git come from the host), and the AppImage on another machine. Added the same day: the logo (`apps/desktop/assets/icon.svg`, isometric pixel building in the UI palette, rendered to `icon.png` for electron-builder, the window icon and the launcher) and `scripts/install-desktop.sh`, which installs `release/linux-unpacked` to `~/.local/lib/office` with an `office.desktop` entry in the applications menu and on the Desktop (no FUSE needed). Not built: a settings UI for workspace roots (the `env` file covers it), migration of an existing Docker database, Windows and macOS.
