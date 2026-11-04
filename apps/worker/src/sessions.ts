import { spawn, execFile } from 'node:child_process';
import { accessSync, constants, realpathSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';
import type { ClaudeSessionStore } from '@office/runtime';
import type { ClaudeSessionInfo, SessionsErrorCode, SessionsQuery, SessionsResult, TranscriptEntry } from '@office/shared';

const MAX_TEXT = 8000;
const AGENTS_TIMEOUT_MS = 5000;

export interface LiveAgent {
  sessionId: string;
  pid?: number;
  kind: string;
  status?: string;
  state?: string;
  id?: string;
  name?: string;
}

/** A session a process holds right now: interactive ones, and background ones still running. */
export const isRunning = (l: LiveAgent) => l.kind !== 'background' || l.state === 'running' || l.state === undefined;

export interface SessionsDeps {
  store: Pick<ClaudeSessionStore, 'listSessions' | 'getSessionMessages'>;
  /** Sessions the CLI reports as running right now (`claude agents --json`); empty when unsupported. */
  liveSessions: () => Promise<LiveAgent[]>;
  /** Starts a terminal running `claude --resume <sessionId>` in `dir`; resolves with the terminal's name. */
  spawnTerminal: (dir: string, sessionId: string) => Promise<string>;
  /** Runs `claude <args>` to completion (background session start/stop/rm); resolves with its output, rejects on failure. */
  claude?: (args: string[], cwd?: string) => Promise<string>;
}

export type SessionsOutcome = { result: SessionsResult; error?: undefined } | { error: { code: SessionsErrorCode; message: string }; result?: undefined };

/** True if `path` is `root` or inside it, compared by path segment. */
function isUnderRoot(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith('/') ? root : root + '/');
}

// a session's cwd may be gone; then there is no link left to escape through, so the plain resolve is safe
function realOrResolved(path: string) {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

const fail = (code: SessionsErrorCode, message: string): SessionsOutcome => ({ error: { code, message } });

/** One turn per user or assistant message: text blocks joined, tool names kept, tool results and thinking dropped. */
export function reduceMessage(m: { type: string; uuid: string; message: unknown }): TranscriptEntry | undefined {
  if (m.type !== 'user' && m.type !== 'assistant') return undefined;
  const content = (m.message as { content?: unknown } | undefined)?.content;
  const texts: string[] = [];
  const tools: string[] = [];
  if (typeof content === 'string') texts.push(content);
  else if (Array.isArray(content)) {
    for (const b of content as { type?: string; text?: string; name?: string }[]) {
      if (b?.type === 'text' && typeof b.text === 'string') texts.push(b.text);
      else if (b?.type === 'tool_use' && typeof b.name === 'string') tools.push(b.name);
    }
  }
  const text = texts.join('\n').replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim().slice(0, MAX_TEXT);
  if (!text && tools.length === 0) return undefined;
  return { uuid: m.uuid, role: m.type, text, tools };
}

/** Answers one `sessions.request`; `roots` are the worker's real workspace roots. */
export async function handleSessionsQuery(query: SessionsQuery, roots: string[], deps: SessionsDeps): Promise<SessionsOutcome> {
  const underRoots = (p: string) => roots.some((r) => isUnderRoot(p, r));
  try {
    switch (query.kind) {
      case 'list': {
        const [all, live] = await Promise.all([deps.store.listSessions({ includeProgrammatic: false, limit: query.limit }), deps.liveSessions()]);
        const liveById = new Map(live.map((l) => [l.sessionId, l]));
        const sessions: ClaudeSessionInfo[] = [];
        for (const s of all) {
          if (!s.cwd || !underRoots(realOrResolved(s.cwd))) continue;
          const l = liveById.get(s.sessionId);
          sessions.push({
            sessionId: s.sessionId,
            title: s.customTitle || s.summary,
            cwd: s.cwd,
            gitBranch: s.gitBranch,
            createdAt: s.createdAt,
            lastModified: s.lastModified,
            fileSize: s.fileSize,
            ...(l ? { live: { pid: l.pid, kind: l.kind, status: l.status, state: l.state, id: l.id, name: l.name } } : {}),
          });
        }
        return { result: { kind: 'list', sessions } };
      }
      case 'messages': {
        if (!underRoots(realOrResolved(query.dir))) return fail('outside_roots', `${query.dir} is outside the workspace roots`);
        const raw = await deps.store.getSessionMessages(query.sessionId, { dir: query.dir, offset: query.offset, limit: query.limit });
        const entries = raw.map(reduceMessage).filter((e): e is TranscriptEntry => !!e);
        return { result: { kind: 'messages', entries, nextOffset: raw.length < query.limit ? null : query.offset + raw.length } };
      }
      case 'background': {
        const claude = deps.claude ?? runClaude;
        if (query.action !== 'start') {
          if (!query.id) return fail('internal_error', 'id required');
          const output = await claude([query.action, query.id]).catch((err: Error) => {
            throw Object.assign(err, { code: 'claude_failed' });
          });
          return { result: { kind: 'background', output } };
        }
        if (!query.dir || !query.prompt) return fail('internal_error', 'dir and prompt required');
        const dir = realOrResolved(query.dir);
        if (!underRoots(dir)) return fail('outside_roots', `${query.dir} is outside the workspace roots`);
        const output = await claude(['--bg', query.prompt], dir).catch((err: Error) => {
          throw Object.assign(err, { code: 'claude_failed' });
        });
        // the CLI prints "claude attach <id>" lines for the new session
        const id = /claude attach (\S+)/.exec(output)?.[1];
        return { result: { kind: 'background', id, output } };
      }
      case 'open': {
        const dir = realOrResolved(query.dir);
        if (!underRoots(dir)) return fail('outside_roots', `${query.dir} is outside the workspace roots`);
        const running = (await deps.liveSessions()).find((l) => l.sessionId === query.sessionId && isRunning(l));
        if (running) return fail('session_live', `session is running in another process (pid ${running.pid ?? running.id})`);
        const terminal = await deps.spawnTerminal(dir, query.sessionId).catch((err: Error) => {
          throw Object.assign(err, { code: 'no_terminal' });
        });
        return { result: { kind: 'open', terminal } };
      }
    }
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    return fail(code === 'no_terminal' || code === 'claude_failed' ? code : 'internal_error', (err as Error).message);
  }
}

const CLAUDE_TIMEOUT_MS = 60_000;

/** `claude <args>` with the worker's environment minus Office's; stdout on success, the first stderr line on failure. */
export function runClaude(args: string[], cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = {};
    for (const [k, v] of Object.entries(process.env)) if (!/^(DATABASE_URL|OFFICE_)|^(COOKIE_SECRET|REDIS_URL)$/.test(k)) env[k] = v;
    execFile('claude', args, { cwd, env, timeout: CLAUDE_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || stdout || err.message).trim().split('\n')[0]?.slice(0, 300) || 'claude failed'));
      resolve(stdout);
    });
  });
}

let warnedAgents = false;

/**
 * `claude agents --json --all`: the interactive sessions alive on this machine and the background ones, finished included;
 * `[]` on any failure (an older CLI without it: warned once, nothing is guessed from file times).
 */
export function readLiveSessions(warn: (msg: string) => void = (m) => console.warn(m)): Promise<LiveAgent[]> {
  return new Promise((resolve) => {
    execFile('claude', ['agents', '--json', '--all'], { timeout: AGENTS_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err) {
        if (!warnedAgents) warn(`claude agents --json failed (${err.message.split('\n')[0]}): sessions show no live status and a running session is not refused a second resume`);
        warnedAgents = true;
        return resolve([]);
      }
      try {
        const rows = JSON.parse(stdout) as unknown;
        resolve(
          Array.isArray(rows)
            ? rows
                .filter((r): r is LiveAgent => typeof r?.sessionId === 'string')
                .map((r) => ({ sessionId: r.sessionId, pid: r.pid, kind: String(r.kind), status: r.status, state: r.state, id: r.id, name: r.name }))
            : [],
        );
      } catch {
        resolve([]);
      }
    });
  });
}

// argv per emulator; the resume command is always passed as separate arguments, never through a shell
const TERMINALS: [string, (dir: string, cmd: string[]) => string[]][] = [
  ['kitty', (d, c) => ['--directory', d, ...c]],
  ['alacritty', (d, c) => ['--working-directory', d, '-e', ...c]],
  ['wezterm', (d, c) => ['start', '--cwd', d, '--', ...c]],
  ['ghostty', (d, c) => [`--working-directory=${d}`, '-e', ...c]],
  ['foot', (d, c) => ['--working-directory', d, ...c]],
  ['konsole', (d, c) => ['--workdir', d, '-e', ...c]],
  ['gnome-terminal', (d, c) => [`--working-directory=${d}`, '--', ...c]],
  ['xterm', (_d, c) => ['-e', ...c]],
  ['x-terminal-emulator', (_d, c) => ['-e', ...c]],
];

function onPath(exe: string, env: NodeJS.ProcessEnv): boolean {
  if (exe.includes('/')) return true;
  return (env.PATH ?? '').split(delimiter).some((dir) => {
    try {
      accessSync(join(dir, exe), constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

/** Opens `$TERMINAL` or the first installed emulator with `claude --resume <sessionId>` in `dir`, detached from the worker. */
export function openTerminal(dir: string, sessionId: string, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const cmd = ['claude', '--resume', sessionId];
  if (!env.DISPLAY && !env.WAYLAND_DISPLAY) return Promise.reject(new Error('the worker has no display to open a terminal on'));
  const pick: [string, string[]] | undefined = env.TERMINAL
    ? [env.TERMINAL, ['-e', ...cmd]]
    : TERMINALS.filter(([exe]) => onPath(exe, env)).map(([exe, argv]): [string, string[]] => [exe, argv(dir, cmd)])[0];
  if (!pick) return Promise.reject(new Error('no terminal emulator found (set TERMINAL)'));
  const [exe, argv] = pick;
  return new Promise((resolve, reject) => {
    const child = spawn(exe, argv, { cwd: dir, env, detached: true, stdio: 'ignore' });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve(exe);
    });
  });
}
