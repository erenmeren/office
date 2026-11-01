import { join } from 'node:path';
import pino, { type Logger } from 'pino';
import WebSocket from 'ws';
import type { RuntimeAdapter } from '@office/runtime';
import { ApiToWorkerSchema, type ApiToWorker, type ToolCallResult, type WorkerToApi } from '@office/shared';
import type { WorkerConfig } from './config.js';
import { loadCredential, saveCredential } from './credentials.js';
import { Outbox } from './outbox.js';
import { RunExecutor } from './executor.js';
import { sweepRunRoots } from './skills.js';

const MIN_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30_000;
const START_TIMEOUT_MS = 10_000;
// auth failed / revoked / replaced by another connection: retrying cannot help
const FATAL_CLOSE_CODES = new Set([4401, 4403, 4409]);
const DISCONNECTED: ToolCallResult = { ok: false, code: 'disconnected', error: 'worker disconnected' };

export interface ConnectionOptions {
  adapter: RuntimeAdapter;
  heartbeatMs?: number;
  /** First reconnect delay; doubles up to 30 s. Default 1 s. */
  reconnectBaseMs?: number;
  logger?: Logger;
}

export class WorkerConnection {
  private executor: RunExecutor;
  private log: Logger;
  private heartbeatMs: number;
  private reconnectBaseMs: number;
  private socket?: WebSocket;
  private credential: string | null = null;
  private backoffMs: number;
  // results produced while disconnected, sent after the next welcome
  private unsentResults = new Map<string, WorkerToApi>();
  // approval requests made while disconnected, sent after the next welcome; the API's timeout then applies
  private unsentApprovals = new Map<string, WorkerToApi>();
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
    this.executor = new RunExecutor(opts.adapter, (msg) => this.send(msg), config.workspaceRoots, this.runsDir, undefined, this.log);
  }

  /** Connects and resolves once the API welcomes this worker. */
  async start(): Promise<void> {
    await sweepRunRoots(this.runsDir, []); // no runs are active at start
    for (const [runId, msg] of await this.outbox.load()) this.unsentResults.set(runId, msg);
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
      });
    });
    socket.on('message', (data) => {
      void this.onMessage(String(data)).catch((err) => this.log.error({ err }, 'worker message failed'));
    });
    socket.on('error', (err) => this.log.warn({ err: err.message }, 'worker socket error'));
    socket.on('close', (code) => {
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
        for (const result of this.unsentResults.values()) this.send(result);
        const approvals = [...this.unsentApprovals.values()];
        this.unsentApprovals.clear();
        for (const request of approvals) this.send(request);
        clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = setInterval(
          () => this.send({ type: 'heartbeat', capacity: this.config.capacity, activeRunIds: this.activeRunIds() }),
          this.heartbeatMs,
        );
        this.log.info({ workerId: msg.workerId }, 'connected to API');
        this.started?.resolve();
        this.started = undefined;
        return;
      case 'run.assign':
        this.log.info({ runId: msg.spec.runId }, 'run assigned');
        this.executor.accept(msg.spec);
        return;
      case 'tool.result':
        this.executor.resolveTool(msg.callId, msg.result);
        return;
      case 'approval.result':
        this.executor.resolveApproval(msg.runId, msg.decision);
        return;
      case 'run.cancel':
        this.log.info({ runId: msg.runId }, 'run cancelled by API');
        this.executor.cancel(msg.runId);
        return;
      case 'error':
        this.log.warn({ message: msg.message }, 'API reported an error');
        // the lease is gone: the API will retry the run, so the stored result is dead weight
        const lost = /^No live lease for run (\S+) on this worker/.exec(msg.message)?.[1];
        if (lost) {
          this.unsentResults.delete(lost);
          await this.outbox.delete(lost);
        }
        return;
    }
  }

  private failStart(err: Error) {
    this.started?.reject(err);
    this.started = undefined;
  }

  /** Executing runs plus finished runs whose result is not sent yet; both keep their lease. */
  private activeRunIds(): string[] {
    return [...new Set([...this.executor.activeRunIds(), ...this.unsentResults.keys()])];
  }

  // shortcut: only run.result is preserved across a disconnect; events produced while disconnected are dropped
  // (gaps in the stored stream), add a send buffer if event completeness matters
  private send(msg: WorkerToApi) {
    const open = this.socket?.readyState === WebSocket.OPEN;
    if (msg.type === 'run.result') {
      // persist first, then send if the socket is open by then; the entry goes after a send
      this.unsentResults.set(msg.runId, msg);
      void this.outbox
        .put(msg.runId, msg)
        .then(async () => {
          if (this.socket?.readyState !== WebSocket.OPEN || this.unsentResults.get(msg.runId) !== msg) return;
          this.socket.send(JSON.stringify(msg));
          this.unsentResults.delete(msg.runId);
          await this.outbox.delete(msg.runId);
        })
        .catch((err) => this.log.error({ err, runId: msg.runId }, 'result outbox failed'));
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
    if (open) this.socket!.send(JSON.stringify(msg));
  }
}
