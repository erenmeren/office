import { realpathSync, statSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import pino, { type Logger } from 'pino';
import WebSocket from 'ws';
import { claudeSessionStore, type RuntimeAdapter } from '@office/runtime';
import { ApiToWorkerSchema, type ApiToWorker, type OfficeEvent, type ToolCallResult, type WorkerToApi } from '@office/shared';
import { GRANTED_ROOTS_FILE, readGrantedRoots, type WorkerConfig } from './config.js';
import { loadCredential, saveCredential } from './credentials.js';
import { Outbox } from './outbox.js';
import { RunExecutor } from './executor.js';
import { handleSessionsQuery, openTerminal, readLiveSessions, type SessionsDeps } from './sessions.js';
import { TerminalManager, type TerminalDeps } from './terminals.js';
import { sweepRunRoots } from './skills.js';

const MIN_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30_000;
const START_TIMEOUT_MS = 10_000;
// auth failed / revoked / replaced by another connection: retrying cannot help
const FATAL_CLOSE_CODES = new Set([4401, 4403, 4409]);
// per-run cap on events buffered while not welcomed; the oldest are dropped beyond it
const MAX_BUFFERED_EVENTS = 5000;
// already-sent events kept per live run and re-sent after a reconnect (the API ignores duplicates by (sessionId, seq))
const RECENT_EVENTS = 50;
// an unacknowledged result is re-sent on the next heartbeat after this long
const RESULT_RESEND_MS = 30_000;
const DISCONNECTED: ToolCallResult = { ok: false, code: 'disconnected', error: 'worker disconnected' };

export interface ConnectionOptions {
  adapter: RuntimeAdapter;
  heartbeatMs?: number;
  /** First reconnect delay; doubles up to 30 s. Default 1 s. */
  reconnectBaseMs?: number;
  logger?: Logger;
  /** Session discovery backends (tests inject fakes). */
  sessions?: SessionsDeps;
  /** Manual-session terminal backends (tests run a shell instead of claude). */
  terminals?: Partial<TerminalDeps>;
}

export class WorkerConnection {
  private sessions: SessionsDeps;
  private terminals: TerminalManager;
  private executor: RunExecutor;
  private log: Logger;
  private heartbeatMs: number;
  private reconnectBaseMs: number;
  private socket?: WebSocket;
  private credential: string | null = null;
  private backoffMs: number;
  // results not yet acknowledged by the API (run.result.ack), re-sent after every welcome
  private unsentResults = new Map<string, WorkerToApi>();
  // approval requests and integration checks made while disconnected, sent after the next welcome
  private unsentApprovals = new Map<string, WorkerToApi>();
  // when each unacknowledged result was last written to the socket
  private resultSentAt = new Map<string, number>();
  // shortcut: events live in memory only, so a worker restart still loses the unsent ones; persist them if that matters
  private unsentEvents = new Map<string, OfficeEvent[]>();
  private recentEvents = new Map<string, OfficeEvent[]>();
  private droppedEvents = new Map<string, { from: number; to: number }>();
  // set once the welcome is handled: until then events are buffered so they cannot overtake the flush
  private welcomed = false;
  private heartbeatTimer?: NodeJS.Timeout;
  private reconnectTimer?: NodeJS.Timeout;
  private stopped = false;
  private runsDir: string;
  private outbox: Outbox;
  private started?: { resolve: () => void; reject: (err: Error) => void };

  constructor(
    private config: WorkerConfig,
    opts: ConnectionOptions,
  ) {
    this.runsDir = join(config.home, 'runs');
    this.outbox = new Outbox(join(config.home, 'outbox'));
    this.log = opts.logger ?? pino({ level: process.env.LOG_LEVEL ?? 'info' });
    this.heartbeatMs = opts.heartbeatMs ?? 10_000;
    this.reconnectBaseMs = opts.reconnectBaseMs ?? MIN_BACKOFF_MS;
    this.backoffMs = this.reconnectBaseMs;
    this.sessions = opts.sessions ?? { store: claudeSessionStore, liveSessions: () => readLiveSessions((m) => this.log.warn(m)), spawnTerminal: openTerminal };
    this.terminals = new TerminalManager(config.workspaceRoots, (msg) => this.send(msg), {
      liveSessions: this.sessions.liveSessions,
      connected: () => this.welcomed && this.socket?.readyState === WebSocket.OPEN,
      ...opts.terminals,
    });
    this.executor = new RunExecutor(opts.adapter, (msg) => this.send(msg), config.workspaceRoots, this.runsDir, undefined, this.log, {
      apiUrl: config.apiUrl,
      canClone: config.canClone,
      credential: () => this.credential,
    });
  }

  /** Connects and resolves once the API welcomes this worker. */
  async start(): Promise<void> {
    await sweepRunRoots(this.runsDir, []); // no runs are active at start
    for (const [runId, msg] of await this.outbox.load((file, err) => this.log.warn({ file, err }, 'skipping unreadable outbox entry'))) this.unsentResults.set(runId, msg);
    this.credential = await loadCredential(this.config.home);
    if (!this.credential && !this.config.enrollToken) {
      throw new Error('No saved credential and no enroll token (OFFICE_ENROLL_TOKEN)');
    }
    const welcomed = new Promise<void>((resolve, reject) => (this.started = { resolve, reject }));
    const timer = setTimeout(() => this.failStart(new Error('no welcome from the API within 10 s')), START_TIMEOUT_MS);
    this.connect();
    try {
      await welcomed;
    } catch (err) {
      await this.stop();
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Stops reconnecting, closes the socket, then aborts local runs; their leases expire and the API retries them. */
  async stop(): Promise<void> {
    this.stopped = true;
    clearInterval(this.heartbeatTimer);
    clearTimeout(this.reconnectTimer);
    const socket = this.socket;
    // close first so the aborted runs' results are not sent as user cancellations
    const closed = socket && socket.readyState !== WebSocket.CLOSED && new Promise((r) => socket.once('close', r));
    socket?.close();
    for (const runId of this.executor.activeRunIds()) this.executor.cancel(runId);
    this.terminals.closeAll();
    if (closed) await closed;
  }

  private connect() {
    const socket = new WebSocket(`${this.config.apiUrl}/ws/worker`);
    this.socket = socket;
    socket.on('open', () => {
      this.send({
        type: 'hello',
        ...(this.credential ? { credential: this.credential } : { enrollToken: this.config.enrollToken }),
        name: this.config.name,
        capacity: this.config.capacity,
        allowedRoots: this.config.workspaceRoots,
        // reattach: the API renews leases of runs still executing here
        activeRunIds: this.activeRunIds(),
        tags: this.config.tags,
        canClone: this.config.canClone,
        machineId: this.config.machineId,
      });
    });
    socket.on('message', (data) => {
      void this.onMessage(String(data)).catch((err) => this.log.error({ err }, 'worker message failed'));
    });
    socket.on('error', (err) => this.log.warn({ err: err.message }, 'worker socket error'));
    socket.on('close', (code) => {
      this.welcomed = false;
      clearInterval(this.heartbeatTimer);
      // answers to calls in flight would go to the closed socket and never arrive
      this.executor.failPendingTools();
      if (this.stopped) return;
      if (FATAL_CLOSE_CODES.has(code)) {
        this.log.error({ code }, 'API closed the connection; not reconnecting');
        this.stopped = true;
        for (const runId of this.executor.activeRunIds()) this.executor.cancel(runId);
        this.failStart(new Error(`API closed the connection (code ${code})`));
        return;
      }
      this.log.warn({ code, retryInMs: this.backoffMs }, 'disconnected from API; reconnecting');
      this.reconnectTimer = setTimeout(() => this.connect(), this.backoffMs);
      this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
    });
  }

  private async onMessage(raw: string) {
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      json = undefined;
    }
    const parsed = ApiToWorkerSchema.safeParse(json);
    if (!parsed.success) {
      this.log.warn({ raw }, 'ignoring invalid message from API');
      return;
    }
    const msg: ApiToWorker = parsed.data;
    switch (msg.type) {
      case 'welcome':
        if (msg.credential) {
          await saveCredential(this.config.home, msg.credential);
          this.credential = msg.credential;
        }
        this.backoffMs = this.reconnectBaseMs;
        this.welcomed = true;
        // events first: an applied result ends the lease and the API then drops late events
        this.flushEvents();
        for (const result of this.unsentResults.values()) this.send(result);
        this.terminals.announce();
        const approvals = [...this.unsentApprovals.values()];
        this.unsentApprovals.clear();
        for (const request of approvals) {
          // a check the executor already settled (timer) must not be sent late
          if (request.type === 'integration.check' && !this.executor.hasPendingIntegration(request.runId)) continue;
          this.send(request);
        }
        clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = setInterval(() => {
          this.send({ type: 'heartbeat', capacity: this.config.capacity, activeRunIds: this.activeRunIds() });
          // a result the API never acknowledged on a live socket (lost in flight) is sent again
          const now = Date.now();
          for (const [runId, result] of this.unsentResults) {
            const sentAt = this.resultSentAt.get(runId);
            if (sentAt !== undefined && now - sentAt > RESULT_RESEND_MS) this.sendResult(runId, result);
          }
        }, this.heartbeatMs);
        this.log.info({ workerId: msg.workerId }, 'connected to API');
        this.started?.resolve();
        this.started = undefined;
        return;
      case 'run.assign': {
        this.log.info({ runId: msg.spec.runId }, 'run assigned');
        // a resumed run: the API has applied its previous (suspended) result, so a stale copy must not be re-sent;
        // any other stored result is still owed to the API
        const stored = this.unsentResults.get(msg.spec.runId);
        if (stored?.type === 'run.result' && stored.result.status === 'suspended') {
          this.unsentResults.delete(msg.spec.runId);
          await this.outbox.delete(msg.spec.runId);
        }
        this.executor.accept(msg.spec);
        return;
      }
      case 'tool.result':
        this.executor.resolveTool(msg.callId, msg.result);
        return;
      case 'run.result.ack':
        this.forgetRun(msg.runId);
        await this.outbox.delete(msg.runId);
        return;
      case 'integration.allowed':
        this.executor.resolveIntegration(msg.runId, msg.ok, msg.reason);
        return;
      case 'approval.result':
        this.executor.resolveApproval(msg.runId, msg.decision);
        return;
      case 'run.cancel':
        this.log.info({ runId: msg.runId }, 'run cancelled by API');
        this.executor.cancel(msg.runId);
        return;
      case 'run.interrupt':
        this.log.info({ runId: msg.runId }, 'run interrupted by the owner');
        this.executor.interrupt(msg.runId);
        return;
      case 'roots.add':
        await this.addRoot(msg.requestId, msg.path);
        return;
      case 'terminal.open':
        await this.terminals.open(msg);
        return;
      case 'terminal.input':
        this.terminals.input(msg.terminalId, msg.data);
        return;
      case 'terminal.resize':
        this.terminals.resize(msg.terminalId, msg.cols, msg.rows);
        return;
      case 'terminal.close':
        this.terminals.close(msg.terminalId);
        return;
      case 'sessions.request': {
        // answered out of order on purpose: a slow transcript read must not hold up run messages
        void handleSessionsQuery(msg.query, this.config.workspaceRoots, this.sessions).then((out) =>
          this.send({ type: 'sessions.response', requestId: msg.requestId, ...out }),
        );
        return;
      }
      case 'error': {
        this.log.warn({ message: msg.message }, 'API reported an error');
        // the lease is gone: the API will retry the run, so the stored result is dead weight
        const lost = /^No live lease for run (\S+) on this worker/.exec(msg.message)?.[1];
        if (lost) {
          this.forgetRun(lost);
          await this.outbox.delete(lost);
        }
        return;
      }
    }
  }

  /** Grants a workspace root the owner chose for a project; the roots array is shared with the executor and the terminals. */
  private async addRoot(requestId: string, path: string) {
    const roots = this.config.workspaceRoots;
    const answer = (error?: string) => this.send({ type: 'roots.changed', requestId, allowedRoots: [...roots], ...(error ? { error } : {}) });
    let real: string;
    try {
      real = realpathSync(resolve(path));
      if (!statSync(real).isDirectory()) return answer(`${path} is not a directory`);
    } catch {
      return answer(`${path} does not exist on this worker`);
    }
    if (!roots.some((r) => real === r || real.startsWith(r.endsWith('/') ? r : r + '/'))) {
      roots.push(real);
      const granted = [...new Set([...readGrantedRoots(this.config.home), real])];
      await writeFile(join(this.config.home, GRANTED_ROOTS_FILE), JSON.stringify(granted, null, 2) + '\n', { mode: 0o600 }).catch((err: unknown) =>
        this.log.error({ err, path: real }, 'granted root not persisted; it is lost at the next restart'),
      );
      this.log.info({ path: real }, 'workspace root granted by the owner');
    }
    answer();
  }

  private failStart(err: Error) {
    this.started?.reject(err);
    this.started = undefined;
  }

  /** Executing runs plus finished runs whose result is not sent yet; both keep their lease. */
  private activeRunIds(): string[] {
    return [...new Set([...this.executor.activeRunIds(), ...this.unsentResults.keys()])];
  }

  private forgetRun(runId: string) {
    this.unsentResults.delete(runId);
    this.resultSentAt.delete(runId);
    this.unsentEvents.delete(runId);
    this.recentEvents.delete(runId);
    this.droppedEvents.delete(runId);
  }

  private sendResult(runId: string, msg: WorkerToApi) {
    this.socket!.send(JSON.stringify(msg));
    this.resultSentAt.set(runId, Date.now());
  }

  private sendEvent(event: OfficeEvent) {
    this.socket!.send(JSON.stringify({ type: 'run.event', event }));
    const recent = this.recentEvents.get(event.runId) ?? [];
    recent.push(event);
    if (recent.length > RECENT_EVENTS) recent.shift();
    this.recentEvents.set(event.runId, recent);
  }

  /** Sends every buffered event, preceded by the recently sent ones (dedup'd by the API), in seq order per run. */
  private flushEvents() {
    for (const runId of new Set([...this.recentEvents.keys(), ...this.unsentEvents.keys()])) {
      const dropped = this.droppedEvents.get(runId);
      if (dropped) this.log.warn({ runId, ...dropped }, 'event buffer overflowed while disconnected; events from..to are lost');
      this.droppedEvents.delete(runId);
      const events = [...(this.recentEvents.get(runId) ?? []), ...(this.unsentEvents.get(runId) ?? [])].sort((a, b) => a.seq - b.seq);
      this.recentEvents.delete(runId);
      this.unsentEvents.delete(runId);
      for (const event of events) this.sendEvent(event);
    }
  }

  private send(msg: WorkerToApi) {
    const open = this.socket?.readyState === WebSocket.OPEN;
    if (msg.type === 'run.result') {
      // persist first, then send if welcomed by then; the entry goes on run.result.ack (or a lost-lease error)
      this.unsentResults.set(msg.runId, msg);
      void this.outbox
        .put(msg.runId, msg)
        .then(() => {
          if (!this.welcomed || this.socket?.readyState !== WebSocket.OPEN || this.unsentResults.get(msg.runId) !== msg) return;
          this.sendResult(msg.runId, msg);
        })
        .catch((err) => this.log.error({ err, runId: msg.runId }, 'result outbox failed'));
      return;
    }
    if (msg.type === 'run.event') {
      if (this.welcomed && open) return this.sendEvent(msg.event);
      const buffer = this.unsentEvents.get(msg.event.runId) ?? [];
      buffer.push(msg.event);
      if (buffer.length > MAX_BUFFERED_EVENTS) {
        const lost = buffer.shift()!;
        const dropped = this.droppedEvents.get(lost.runId);
        this.droppedEvents.set(lost.runId, { from: dropped?.from ?? lost.seq, to: lost.seq });
      }
      this.unsentEvents.set(msg.event.runId, buffer);
      return;
    }
    // tool calls are not buffered: a call made while disconnected fails at once
    if (msg.type === 'tool.call' && !open) {
      this.executor.resolveTool(msg.callId, DISCONNECTED);
      return;
    }
    // one already sent stays pending across a reconnect; the API re-sends its decision
    if (msg.type === 'approval.request' && !open) {
      this.unsentApprovals.set(msg.request.requestId, msg);
      return;
    }
    // the executor's 30 s timer bounds the wait for a reconnect
    if (msg.type === 'integration.check' && !open) {
      this.unsentApprovals.set(`integration:${msg.runId}`, msg);
      return;
    }
    if (open) this.socket!.send(JSON.stringify(msg));
  }
}
