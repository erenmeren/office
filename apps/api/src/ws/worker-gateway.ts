import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import type { PrismaClient } from '@office/db';
import { WorkerToApiSchema, type ApiToWorker, type WorkerToApi } from '@office/shared';
import { redactSecrets } from '@office/runtime';
import type { Config } from '../config.js';
import { generateToken, hashToken } from '../lib/tokens.js';
import type { EventHub } from '../services/event-hub.js';
import { appendEvent } from '../services/event-store.js';
import { completeRun, findLeasedRun, markRunning, renewLeases } from '../services/run-service.js';

interface Connection {
  socket: WebSocket;
  capacity: number;
  activeRuns: Set<string>;
  allowedRoots: string[];
}

type Hello = Extract<WorkerToApi, { type: 'hello' }>;

export class WorkerGateway {
  private conns = new Map<string, Connection>();

  constructor(
    private prisma: PrismaClient,
    private hub: EventHub,
    private config: Config,
    private log: FastifyBaseLogger,
  ) {}

  register(app: FastifyInstance) {
    app.get('/ws/worker', { websocket: true }, (socket) => this.accept(socket));
  }

  onlineWorkers() {
    return [...this.conns].map(([workerId, c]) => ({
      workerId,
      capacity: c.capacity,
      activeRuns: c.activeRuns.size,
      allowedRoots: c.allowedRoots,
    }));
  }

  send(workerId: string, msg: ApiToWorker): boolean {
    const conn = this.conns.get(workerId);
    if (!conn || conn.socket.readyState !== conn.socket.OPEN) return false;
    if (msg.type === 'run.assign') conn.activeRuns.add(msg.spec.runId);
    conn.socket.send(JSON.stringify(msg));
    return true;
  }

  releaseRun(workerId: string, runId: string) {
    this.conns.get(workerId)?.activeRuns.delete(runId);
  }

  /** Closes the worker's socket, if connected (used on revoke). */
  disconnect(workerId: string, code = 4403) {
    this.conns.get(workerId)?.socket.close(code, 'revoked');
  }

  private accept(socket: WebSocket) {
    let workerId: string | undefined;
    // one socket's messages are handled strictly in order (accepted before result, etc.)
    let chain = Promise.resolve();
    const reply = (msg: ApiToWorker) => socket.send(JSON.stringify(msg));

    const handle = async (raw: string) => {
      let json: unknown;
      try {
        json = JSON.parse(raw);
      } catch {
        json = undefined;
      }
      const parsed = WorkerToApiSchema.safeParse(json);
      if (!workerId) {
        if (!parsed.success || parsed.data.type !== 'hello') {
          const isHello = (json as { type?: unknown } | undefined)?.type === 'hello';
          reply({ type: 'error', message: isHello ? 'invalid hello' : 'first message must be hello' });
          socket.close(isHello ? 4401 : 4400);
          return;
        }
        workerId = await this.hello(socket, parsed.data);
        return;
      }
      if (!parsed.success) {
        reply({ type: 'error', message: `invalid message: ${parsed.error.message}` });
        return;
      }
      try {
        await this.dispatch(workerId, parsed.data);
      } catch (err) {
        reply({ type: 'error', message: (err as Error).message });
      }
    };

    socket.on('message', (data) => {
      chain = chain.then(() => handle(String(data))).catch((err) => this.log.error({ err }, 'worker message failed'));
    });
    socket.on('close', () => {
      chain = chain.then(async () => {
        if (!workerId || this.conns.get(workerId)?.socket !== socket) return;
        this.conns.delete(workerId);
        // runs stay leased; expireLeases reclaims them if the worker does not come back
        await this.prisma.worker
          .updateMany({ where: { id: workerId, status: 'online' }, data: { status: 'offline' } })
          .catch((err) => this.log.warn({ err, workerId }, 'could not mark worker offline'));
      });
    });
  }

  /** Authenticates a hello; returns the worker id, or undefined after replying error and closing. */
  private async hello(socket: WebSocket, msg: Hello): Promise<string | undefined> {
    const fail = () => {
      socket.send(JSON.stringify({ type: 'error', message: 'authentication failed' } satisfies ApiToWorker));
      socket.close(4401);
      return undefined;
    };
    let credential: string | undefined;
    let worker;
    if (msg.enrollToken) {
      worker = await this.prisma.worker.findFirst({
        where: { enrollTokenHash: hashToken(msg.enrollToken), status: 'pending' },
      });
      credential = generateToken();
    } else if (msg.credential) {
      worker = await this.prisma.worker.findFirst({
        where: { credentialHash: hashToken(msg.credential), status: { not: 'revoked' } },
      });
    }
    if (!worker) return fail();

    await this.prisma.worker.update({
      where: { id: worker.id },
      data: {
        name: msg.name,
        capacity: msg.capacity,
        allowedRoots: msg.allowedRoots,
        status: 'online',
        lastHeartbeatAt: new Date(),
        ...(credential ? { credentialHash: hashToken(credential), enrollTokenHash: null } : {}),
      },
    });
    const activeRuns = await this.syncRuns(worker.id, msg.activeRunIds);
    this.conns.get(worker.id)?.socket.close(4409, 'replaced by a new connection');
    this.conns.set(worker.id, { socket, capacity: msg.capacity, allowedRoots: msg.allowedRoots, activeRuns });
    socket.send(JSON.stringify({ type: 'welcome', workerId: worker.id, credential } satisfies ApiToWorker));
    return worker.id;
  }

  /** Renews leases for the reported runs this worker still owns and returns that set. */
  private async syncRuns(workerId: string, runIds: string[]) {
    await renewLeases(this.prisma, workerId, runIds, this.config);
    const owned = await this.prisma.taskRun.findMany({
      where: { id: { in: runIds }, workerId, status: { in: ['queued', 'running'] } },
      select: { id: true },
    });
    return new Set(owned.map((r) => r.id));
  }

  private async dispatch(workerId: string, msg: WorkerToApi) {
    switch (msg.type) {
      case 'hello':
        throw new Error('already authenticated');
      case 'heartbeat': {
        await this.prisma.worker.update({
          where: { id: workerId },
          data: { lastHeartbeatAt: new Date(), capacity: msg.capacity },
        });
        const activeRuns = await this.syncRuns(workerId, msg.activeRunIds);
        const conn = this.conns.get(workerId);
        if (conn) Object.assign(conn, { capacity: msg.capacity, activeRuns });
        return;
      }
      case 'run.accepted':
        return markRunning(this.prisma, this.hub, msg.runId, workerId);
      case 'run.rejected':
        // shortcut: the run keeps its lease until it expires and the task is retried; release early if needed
        this.log.warn({ workerId, runId: msg.runId, reason: msg.reason }, 'worker rejected run');
        return;
      case 'run.event': {
        const run = await findLeasedRun(this.prisma, msg.event.runId, workerId);
        if (!run?.session || run.session.id !== msg.event.sessionId) {
          this.log.warn({ workerId, runId: msg.event.runId }, 'dropping event for a run this worker does not lease');
          return;
        }
        const event = {
          ...msg.event,
          agentId: run.session.agentId,
          projectId: run.session.projectId,
          payload: redactSecrets(msg.event.payload),
        };
        if ((await appendEvent(this.prisma, event)).inserted) this.hub.publish(`run:${event.runId}`, event);
        return;
      }
      case 'run.result':
        await completeRun(this.prisma, this.hub, { runId: msg.runId, workerId, result: msg.result });
        this.releaseRun(workerId, msg.runId);
        return;
    }
  }
}
