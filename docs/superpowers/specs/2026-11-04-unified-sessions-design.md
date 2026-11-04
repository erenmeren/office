# Unified Claude Sessions

Owner request (2026-11-04): see the Claude Code sessions started outside Office (a terminal in any folder under the workspace roots), the sessions Office starts, and later Office-managed manual sessions in one place. Office is the owner's central development screen; it must save tokens (find the old conversation and resume it instead of re-explaining) and stay usable, not grow for comfort alone.

Decided on 2026-11-04 after review of the owner's feature text against the installed versions (Claude Code CLI 2.1.318, Agent SDK 0.3.316):

- The work is split into four phases, each merged on its own. Phase 1 is built now.
- Sessions in folders that are not Office projects are shown too (owner's answer), grouped as "unregistered folders" with a way to register one.
- No migration and no new table in Phase 1: the SDK reads the session files live, `Project.repoPath` maps a session's `cwd` to a project.
- Phase 1 works with the local worker only (the worker on the API's machine). Remote workers' sessions are out of scope.

## Phase 1: external session discovery (built)

**Worker.** Discovery runs where the session files are, so the worker answers it (the API never reads `~/.claude`). Two new protocol messages, request/response:

- API → worker `sessions.request { requestId, query }`; worker → API `sessions.response { requestId, ok, result | error }`.
- `query.kind = 'list'`: `listSessions({ includeProgrammatic: false, limit })` from the SDK, keeping only sessions whose `cwd` resolves under one of the worker's `OFFICE_WORKSPACE_ROOTS` (real paths, segment-wise). Programmatic sessions are the SDK ones, which is how Office itself runs agents, so they are excluded at the source; the API drops any that still match an `AgentSession.sdkSessionId`. Each entry: `sessionId`, `title` (custom title, else summary), `cwd`, `gitBranch`, `createdAt`, `lastModified`, `fileSize`, and `live` when `claude agents --json` reports the session (`pid`, `kind`, `status`, `name`). The CLI call has a 5 s timeout; when it fails or the CLI lacks `agents --json`, `live` is simply absent and nothing is guessed from file mtimes.
- `query.kind = 'messages'`: `getSessionMessages(sessionId, { dir, offset, limit })`, `dir` validated under the roots first. The worker reduces each message to `{ uuid, role, text, tools[] }` (text blocks joined, tool names of `tool_use` blocks, `tool_result` entries skipped, text capped per entry) so the wire and the UI carry no raw API objects.
- `query.kind = 'open'`: spawns a terminal emulator with `claude --resume <sessionId>` in `dir` (executable plus argv, never a shell string; `$TERMINAL` first, then the first installed of `kitty`, `alacritty`, `wezterm`, `ghostty`, `foot`, `konsole`, `gnome-terminal`, `xterm`, `x-terminal-emulator`). Refused with `session_live` when `claude agents --json` still lists the session: the owner's running CLI is not Office's to share, and two processes must never resume one session. Refused with `no_terminal` when none is installed or no display is reachable; the UI then offers the command to copy.

**API.** `WorkerGateway.request()` sends `sessions.request` to a local online worker and resolves on the matching `sessions.response` (10 s timeout; `503 no_local_worker` when none is connected). Routes, owner-authenticated like everything else:

- `GET /claude-sessions`: the worker list joined with projects (`projectId` when `cwd` is the project's `repoPath` or under it), Office SDK sessions removed.
- `GET /claude-sessions/:id/messages?dir&offset&limit`.
- `POST /claude-sessions/:id/open { dir }`.

**Web.** The Live Sessions page keeps its list and inspector for Office agents and gains a "Claude CLI" card under them: sessions grouped by project (the selected project first) and by unregistered folder, each row with title, branch, last activity and a live badge. An unregistered folder has "Add as project" (`POST /projects` with the folder name as slug). Selecting a CLI session shows a read-only transcript on the right (user and assistant turns, tool names, "Load more"), the session's cwd, branch, id and dates, "Open in terminal" (disabled with a note while the session is live) and "Copy command". No message box: an external session cannot be talked to from Office.

**Security.** Workspace roots are the boundary on both the list and every `dir`; symlinks are resolved before the check. The SDK reads only session transcripts; credentials are never read, copied or logged. Terminal processes are detached children of the worker started with argv only. Transcript entries are capped at 8000 characters and a page at 500 entries.

**Not built in Phase 1.** Remote workers, searching transcripts, `forkSession`, status hooks, a settings UI for roots.

## Phase 2: Office-managed manual sessions

A "New manual session" on a project starts a real `claude` process on the local worker under a PTY (`node-pty`), streamed to a terminal component in the web UI (resize, reconnect, stop, resume with `--resume`). Not an SDK session: the owner's own `CLAUDE.md`, plugins and skills apply, Office's agent prompts and skill pins do not. The scheduler never assigns these. Web first; the desktop (Electron) packaging of the native module is a separate step with its own smoke test.

## Phase 3: background agents

`claude agents` / `claude --bg` sessions: list them with their native status, `attach` from the Office terminal when the CLI supports it, never by forcing a resume.

## Phase 4: handoffs

- Manual → Mission: start a mission from a manual session with an owner-approved summary of the conversation passed to the Chief (a summary run, so it costs tokens and is opt-in).
- Mission → manual: open a new manual session on the project after a mission, with the mission summary as the first message.
- Double-resume protection where Office owns both processes.
