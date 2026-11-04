import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import type * as pty from 'node-pty';
import type { ApiToWorker, WorkerToApi } from '@office/shared';
import { isRunning, type LiveAgent } from './sessions.js';

type Open = Extract<ApiToWorker, { type: 'terminal.open' }>;

export interface TerminalDeps {
  /** running Claude sessions, to refuse resuming one twice */
  liveSessions: () => Promise<LiveAgent[]>;
  /** the program to run and its arguments; tests use a shell with none */
  command?: { exe: string; args: string[] };
  env?: NodeJS.ProcessEnv;
  /** false while the API cannot be reached: output is kept and flushed after the next welcome */
  connected?: () => boolean;
}

interface Terminal {
  id: string;
  proc: pty.IPty;
  opened: Extract<WorkerToApi, { type: 'terminal.opened' }>;
  killTimer?: NodeJS.Timeout;
  /** output produced while disconnected, oldest dropped past MAX_PENDING */
  pending: Buffer[];
  pendingBytes: number;
}

// the manual session is the owner's own Claude: keep CLAUDE* and the plugins, drop only Office's secrets and settings
const STRIP = /^(DATABASE_URL|OFFICE_)|^(COOKIE_SECRET|REDIS_URL)$/;
const KILL_GRACE_MS = 5000;
const MAX_PENDING = 256 * 1024;

function isUnderRoot(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith('/') ? root : root + '/');
}

/** The `claude` argv for a terminal: attach to a background session, resume (or fork) a session, or start a new one. */
export function claudeArgs(msg: Pick<Open, 'attachId' | 'resumeSessionId' | 'fork' | 'claudeSessionId'>): string[] {
  if (msg.attachId) return ['attach', msg.attachId];
  if (!msg.resumeSessionId) return ['--session-id', msg.claudeSessionId];
  return msg.fork ? ['--resume', msg.resumeSessionId, '--fork-session', '--session-id', msg.claudeSessionId] : ['--resume', msg.resumeSessionId];
}

/** Office-managed manual Claude sessions: `claude` under a PTY, output streamed to the API, killed with the worker. */
export class TerminalManager {
  private terminals = new Map<string, Terminal>();

  constructor(
    private roots: string[],
    private send: (msg: WorkerToApi) => void,
    private deps: TerminalDeps,
  ) {}

  async open(msg: Open): Promise<void> {
    const fail = (code: 'outside_roots' | 'session_live' | 'spawn_failed', message: string) =>
      this.send({ type: 'terminal.error', terminalId: msg.terminalId, code, message });
    if (this.terminals.has(msg.terminalId)) return this.send(this.terminals.get(msg.terminalId)!.opened);
    let dir: string;
    try {
      dir = realpathSync(resolve(msg.dir));
    } catch {
      return fail('outside_roots', `${msg.dir} does not exist`);
    }
    if (!this.roots.some((r) => isUnderRoot(dir, r))) return fail('outside_roots', `${msg.dir} is outside the workspace roots`);
    // a fork reads the source and writes a new session, so the source may keep running
    if (msg.resumeSessionId && !msg.fork) {
      const running = (await this.deps.liveSessions()).find((l) => l.sessionId === msg.resumeSessionId && isRunning(l));
      if (running) return fail('session_live', `session is running in another process (pid ${running.pid ?? running.id})`);
    }
    const env: Record<string, string> = { TERM: 'xterm-256color', COLORTERM: 'truecolor' };
    for (const [k, v] of Object.entries(this.deps.env ?? process.env)) if (v !== undefined && !STRIP.test(k)) env[k] = v;
    const cmd = this.deps.command ?? { exe: 'claude', args: claudeArgs(msg) };
    let proc: pty.IPty;
    try {
      // loaded on first use: a worker whose node-pty binary does not match its Node (the desktop app's Electron) still runs agents
      const { spawn } = await import('node-pty');
      proc = spawn(cmd.exe, cmd.args, { name: 'xterm-256color', cols: msg.cols, rows: msg.rows, cwd: dir, env });
    } catch (err) {
      return fail('spawn_failed', (err as Error).message);
    }
    const opened: Terminal['opened'] = {
      type: 'terminal.opened',
      terminalId: msg.terminalId,
      pid: proc.pid,
      dir,
      claudeSessionId: msg.claudeSessionId,
      resumedSessionId: msg.resumeSessionId,
      startedAt: new Date().toISOString(),
    };
    const t: Terminal = { id: msg.terminalId, proc, opened, pending: [], pendingBytes: 0 };
    this.terminals.set(t.id, t);
    proc.onData((data) => {
      const chunk = Buffer.from(data, 'utf8');
      if (this.deps.connected?.() === false) {
        t.pending.push(chunk);
        t.pendingBytes += chunk.length;
        while (t.pendingBytes > MAX_PENDING && t.pending.length > 1) t.pendingBytes -= t.pending.shift()!.length;
        return;
      }
      this.send({ type: 'terminal.output', terminalId: t.id, data: chunk.toString('base64') });
    });
    proc.onExit(({ exitCode, signal }) => {
      clearTimeout(t.killTimer);
      this.terminals.delete(t.id);
      this.send({ type: 'terminal.exit', terminalId: t.id, exitCode: exitCode ?? null, signal });
    });
    this.send(opened);
  }

  input(terminalId: string, data: string) {
    this.terminals.get(terminalId)?.proc.write(data);
  }

  resize(terminalId: string, cols: number, rows: number) {
    this.terminals.get(terminalId)?.proc.resize(cols, rows);
  }

  /** SIGHUP like a closed terminal window, SIGKILL if it is still there after 5 s. */
  close(terminalId: string) {
    const t = this.terminals.get(terminalId);
    if (!t) return;
    t.proc.kill('SIGHUP');
    t.killTimer ??= setTimeout(() => this.terminals.has(terminalId) && t.proc.kill('SIGKILL'), KILL_GRACE_MS).unref();
  }

  /** After a reconnect: tells the API about every terminal still alive here, then the output it missed. */
  announce() {
    for (const t of this.terminals.values()) {
      this.send(t.opened);
      if (t.pending.length) this.send({ type: 'terminal.output', terminalId: t.id, data: Buffer.concat(t.pending).toString('base64') });
      t.pending = [];
      t.pendingBytes = 0;
    }
  }

  closeAll() {
    for (const id of this.terminals.keys()) this.close(id);
  }

  get size() {
    return this.terminals.size;
  }
}
