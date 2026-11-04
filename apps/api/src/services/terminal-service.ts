import { randomUUID } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import type { PrismaClient } from '@office/db';
import type { ApiToWorker, TerminalOpened, TerminalStatus, WorkerToApi } from '@office/shared';
import { HttpError } from '../lib/errors.js';
import { isUnderRoot } from '../lib/paths.js';
import type { EventHub } from './event-hub.js';

export interface TerminalView {
  id: string;
  projectId: string | null;
  dir: string;
  workerId: string;
  claudeSessionId: string;
  resumedSessionId?: string;
  /** a fork of `resumedSessionId` into a new session */
  forked?: boolean;
  /** `claude attach <id>` to a background session */
  attachId?: string;
  pid?: number;
  status: TerminalStatus;
  exitCode?: number | null;
  startedAt: string;
  exitedAt?: string;
}

interface Entry extends TerminalView {
  chunks: Buffer[];
  bytes: number;
}

export interface TerminalTransport {
  send(workerId: string, msg: ApiToWorker): boolean;
  localWorkerId(): string | undefined;
  isConnected(workerId: string): boolean;
}

const OPEN_TIMEOUT_MS = 10_000;
const MAX_RUNNING = 8;
// scrollback kept per terminal for late and reconnecting viewers
const MAX_SCROLLBACK = 256 * 1024;

/**
 * Office-managed manual sessions: in-memory only. A terminal lives as long as its worker's process; the API keeps the
 * scrollback and re-adopts terminals a reconnecting worker announces.
 */
export class TerminalRegistry {
  private entries = new Map<string, Entry>();
  private pending = new Map<string, { resolve: (t: TerminalView) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();

  constructor(
    private prisma: PrismaClient,
    private hub: EventHub,
    private transport: TerminalTransport,
    private log: FastifyBaseLogger,
  ) {}

  list(): TerminalView[] {
    return [...this.entries.values()].map(view);
  }

  get(id: string): TerminalView | undefined {
    const e = this.entries.get(id);
    return e && view(e);
  }

  /** base64 of the kept output, for a viewer that just attached */
  scrollback(id: string): string {
    const e = this.entries.get(id);
    return e ? Buffer.concat(e.chunks).toString('base64') : '';
  }

  open(opts: { projectId: string | null; dir: string; resumeSessionId?: string; fork?: boolean; attachId?: string; workerId?: string; cols: number; rows: number }): Promise<TerminalView> {
    const workerId = opts.workerId ? (this.transport.isConnected(opts.workerId) ? opts.workerId : undefined) : this.transport.localWorkerId();
    if (!workerId) return Promise.reject(new HttpError(503, opts.workerId ? 'worker_offline' : 'no_local_worker', opts.workerId ? 'that worker is not connected' : 'no worker is connected from this machine'));
    if ([...this.entries.values()].filter((e) => e.status !== 'exited').length >= MAX_RUNNING) {
      return Promise.reject(new HttpError(409, 'too_many_terminals', `at most ${MAX_RUNNING} manual sessions at once`));
    }
    const id = randomUUID();
    // a plain resume keeps the session id; a fork and a new session get a fresh one; attach shows the background session itself
    const claudeSessionId = opts.resumeSessionId && !opts.fork ? opts.resumeSessionId : randomUUID();
    this.entries.set(id, {
      id, projectId: opts.projectId, dir: opts.dir, workerId, claudeSessionId, resumedSessionId: opts.resumeSessionId, forked: opts.fork || undefined, attachId: opts.attachId,
      status: 'starting', startedAt: new Date().toISOString(), chunks: [], bytes: 0,
    });
    return new Promise<TerminalView>((resolve, reject) => {
      const timer = setTimeout(() => this.settle(id, new HttpError(504, 'worker_timeout', 'the worker did not start the session in time')), OPEN_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.transport.send(workerId, { type: 'terminal.open', terminalId: id, dir: opts.dir, claudeSessionId, resumeSessionId: opts.resumeSessionId, fork: !!opts.fork, attachId: opts.attachId, cols: opts.cols, rows: opts.rows });
    });
  }

  private controllers = new Map<string, object>();

  /** Gives the keyboard of `id` to `holder` (a UI socket); the previous holder is told through `onLost`. */
  takeControl(id: string, holder: object, onLost: (previous: object) => void) {
    const previous = this.controllers.get(id);
    if (previous === holder) return;
    this.controllers.set(id, holder);
    if (previous) onLost(previous);
  }

  releaseControl(holder: object) {
    for (const [id, h] of this.controllers) if (h === holder) this.controllers.delete(id);
  }

  /** Keystrokes from `holder`; ignored unless it holds the keyboard. */
  input(id: string, data: string, holder?: object) {
    const e = this.entries.get(id);
    if (!e || e.status !== 'running') return;
    if (holder && this.controllers.get(id) !== holder) return;
    this.transport.send(e.workerId, { type: 'terminal.input', terminalId: id, data });
  }

  resize(id: string, cols: number, rows: number) {
    const e = this.entries.get(id);
    if (e && e.status === 'running') this.transport.send(e.workerId, { type: 'terminal.resize', terminalId: id, cols, rows });
  }

  /** Stops a running terminal; forgets an exited one. */
  close(id: string): TerminalView {
    const e = this.entries.get(id);
    if (!e) throw new HttpError(404, 'not_found');
    if (e.status === 'exited') {
      this.entries.delete(id);
      this.controllers.delete(id);
      this.hub.publish('global', { type: 'terminal.changed', terminalId: id });
    } else this.transport.send(e.workerId, { type: 'terminal.close', terminalId: id });
    return view(e);
  }

  /** Worker messages; a message about a terminal another worker owns is ignored. */
  async onWorkerMessage(workerId: string, msg: Extract<WorkerToApi, { type: `terminal.${string}` }>) {
    if (msg.type === 'terminal.opened') return this.opened(workerId, msg);
    const e = this.entries.get(msg.terminalId);
    if (!e || e.workerId !== workerId) return;
    switch (msg.type) {
      case 'terminal.error':
        this.entries.delete(e.id);
        this.settle(e.id, new HttpError(msg.code === 'outside_roots' ? 400 : msg.code === 'session_live' ? 409 : 502, msg.code, msg.message));
        return;
      case 'terminal.output': {
        const chunk = Buffer.from(msg.data, 'base64');
        e.chunks.push(chunk);
        e.bytes += chunk.length;
        while (e.bytes > MAX_SCROLLBACK && e.chunks.length > 1) e.bytes -= e.chunks.shift()!.length;
        this.hub.publish(`terminal:${e.id}`, { type: 'terminal.output', data: msg.data });
        return;
      }
      case 'terminal.exit':
        this.exited(e, msg.exitCode);
        return;
    }
  }

  /** The worker's socket closed: its terminals are gone with it, as far as the API can know. */
  onWorkerGone(workerId: string) {
    for (const e of this.entries.values()) if (e.workerId === workerId && e.status !== 'exited') this.exited(e, null);
  }

  private async opened(workerId: string, msg: TerminalOpened) {
    let e = this.entries.get(msg.terminalId);
    if (e && e.workerId !== workerId) return;
    if (!e) {
      // a terminal from before an API restart, re-announced by its worker
      const projects = await this.prisma.project.findMany({ select: { id: true, repoPath: true } });
      e = {
        id: msg.terminalId, projectId: projects.find((p) => isUnderRoot(msg.dir, p.repoPath))?.id ?? null, dir: msg.dir, workerId,
        claudeSessionId: msg.claudeSessionId, resumedSessionId: msg.resumedSessionId, status: 'starting', startedAt: msg.startedAt, chunks: [], bytes: 0,
      };
      this.entries.set(e.id, e);
    }
    if (e.status === 'exited') return;
    Object.assign(e, { pid: msg.pid, status: 'running' as const, dir: msg.dir });
    this.settle(e.id, view(e));
    this.hub.publish('global', { type: 'terminal.changed', terminalId: e.id });
  }

  private exited(e: Entry, exitCode: number | null) {
    Object.assign(e, { status: 'exited' as const, exitCode, exitedAt: new Date().toISOString() });
    this.settle(e.id, new HttpError(502, 'exited', 'the session ended before it started'));
    this.hub.publish(`terminal:${e.id}`, { type: 'terminal.exit', exitCode });
    this.hub.publish('global', { type: 'terminal.changed', terminalId: e.id });
    this.log.info({ terminalId: e.id, exitCode }, 'manual session ended');
  }

  private settle(id: string, outcome: TerminalView | Error) {
    const p = this.pending.get(id);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(id);
    if (outcome instanceof Error) {
      if (this.entries.get(id)?.status === 'starting') this.entries.delete(id);
      p.reject(outcome);
    } else p.resolve(outcome);
  }
}

const view = ({ chunks: _c, bytes: _b, ...rest }: Entry): TerminalView => rest;
