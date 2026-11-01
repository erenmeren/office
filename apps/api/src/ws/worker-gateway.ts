import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import type { PrismaClient } from '@office/db';
import { WorkerToApiSchema, type ApiToWorker, type ToolCallResult, type WorkerToApi } from '@office/shared';
import { redactSecrets } from '@office/runtime';
import type { Config } from '../config.js';
import { isUnderRoot } from '../lib/paths.js';
import { generateToken, hashToken } from '../lib/tokens.js';
import type { EventHub } from '../services/event-hub.js';
import { appendEvent } from '../services/event-store.js';
import { audit } from '../services/audit-service.js';
import { completeRun, findLeasedRun, markRunning, recordCancelledUsage, renewLeases } from '../services/run-service.js';
import { executeTool } from '../services/tool-service.js';
import { recordSubagentEvent } from '../services/subagent-service.js';
import { requestApproval, resendDecisions } from '../services/approval-service.js';

interface Connection {
  socket: WebSocket;
  capacity: number;
  activeRuns: Set<string>;
  allowedRoots: string[];
  tags: string[];
  canClone: boolean;
  machineId?: string;
}

export type OnlineWorker = ReturnType<WorkerGateway['onlineWorkers']>[number];

// worker roots are real paths, so compare the repo's real path too (resolve only if it does not exist here)
function realOrResolved(path: string) {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

const FINAL_RUN = new Set(['succeeded', 'failed', 'cancelled']);

type Hello = Extract<WorkerToApi, { type: 'hello' }>;

// emitted by the API itself; a worker must not forge them
const SERVER_ONLY_EVENTS = new Set([
  'run.lease.lost',
  'run.resume.failed',
  'run.status.changed',
  'task.status.changed',
  'agent.resumed',
  'agent.check.completed',
]);

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
      tags: c.tags,
      canClone: c.canClone,
      /**
       * True when the worker runs on the API's machine and its allowedRoots cover `repoPath`: it can use the repo
       * checkout directly. Matching paths alone are not enough; another host may share the layout.
       */
      local: (repoPath: string) =>
        (c.machineId === undefined ? this.config.trustUnidentifiedWorkers : c.machineId === this.config.machineId) &&
        c.allowedRoots.some((r) => isUnderRoot(realOrResolved(repoPath), r)),
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
    let match;
    if (msg.enrollToken) {
      match = { enrollTokenHash: hashToken(msg.enrollToken), status: 'pending' as const };
      credential = generateToken();
    } else if (msg.credential) {
      match = { credentialHash: hashToken(msg.credential), status: { not: 'revoked' as const } };
    }
    const worker = match && (await this.prisma.worker.findFirst({ where: match, select: { id: true } }));
    if (!match || !worker) return fail();
    // the match is re-checked in the write, so a concurrent enroll or revoke wins over this hello
    const { count } = await this.prisma.worker.updateMany({
      where: { id: worker.id, ...match },
      data: {
        name: msg.name,
        capacity: msg.capacity,
        allowedRoots: msg.allowedRoots,
        tags: msg.tags,
        canClone: msg.canClone,
        machineId: msg.machineId ?? null,
        status: 'online',
        lastHeartbeatAt: new Date(),
        ...(credential ? { credentialHash: hashToken(credential), enrollTokenHash: null } : {}),
      },
    });
    if (count === 0) return fail();
    if (credential) {
      await audit(this.prisma, {
        action: 'worker.enrolled', targetType: 'worker', targetId: worker.id,
        detail: { name: msg.name, ...(msg.machineId ? { machineId: msg.machineId } : {}) },
      });
    }
    await renewLeases(this.prisma, worker.id, msg.activeRunIds, this.config);
    const activeRuns = await this.leasedRuns(worker.id);
    this.conns.get(worker.id)?.socket.close(4409, 'replaced by a new connection');
    this.conns.set(worker.id, {
      socket, capacity: msg.capacity, allowedRoots: msg.allowedRoots, tags: msg.tags, canClone: msg.canClone, machineId: msg.machineId, activeRuns,
    });
    socket.send(JSON.stringify({ type: 'welcome', workerId: worker.id, credential } satisfies ApiToWorker));
    this.cancelUnleased(worker.id, msg.activeRunIds, activeRuns);
    await resendDecisions(this.prisma, this.hub, this, worker.id).catch((err: unknown) =>
      this.log.error({ err, workerId: worker.id }, 're-sending approval decisions failed'),
    );
    return worker.id;
  }

  /** Tells the worker to stop runs it reports but no longer leases (lost, cancelled or finished meanwhile). */
  private cancelUnleased(workerId: string, reported: string[], leased: Set<string>) {
    for (const runId of reported) if (!leased.has(runId)) this.send(workerId, { type: 'run.cancel', runId });
  }

  /** Every run the DB says this worker holds; the worker's own report is not trusted for capacity. */
  private async leasedRuns(workerId: string) {
    const owned = await this.prisma.taskRun.findMany({
      where: { workerId, status: { in: ['queued', 'running', 'waiting_approval'] } },
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
        await renewLeases(this.prisma, workerId, msg.activeRunIds, this.config);
        const conn = this.conns.get(workerId);
        const before = new Set(conn?.activeRuns);
        const activeRuns = await this.leasedRuns(workerId);
        if (!conn) return;
        this.cancelUnleased(workerId, msg.activeRunIds, activeRuns);
        // keep runs assigned while the query ran; they may not have been visible to it
        for (const id of conn.activeRuns) if (!before.has(id)) activeRuns.add(id);
        Object.assign(conn, { capacity: msg.capacity, activeRuns });
        return;
      }
      case 'run.accepted':
        return markRunning(this.prisma, this.hub, msg.runId, workerId);
      case 'run.rejected':
        // shortcut: the run keeps its lease until it expires and the task is retried; release early if needed
        this.log.warn({ workerId, runId: msg.runId, reason: msg.reason }, 'worker rejected run');
        return;
      case 'run.event': {
        if (SERVER_ONLY_EVENTS.has(msg.event.type)) throw new Error(`event type ${msg.event.type} is server-only`);
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
        if (!(await appendEvent(this.prisma, event, this.hub)).inserted) return;
        await recordSubagentEvent(this.prisma, event).catch((err: unknown) =>
          this.log.error({ err, runId: event.runId, seq: event.seq }, 'failed to record subagent event'),
        );
        return;
      }
      case 'tool.call': {
        const reply = (result: ToolCallResult) => this.send(workerId, { type: 'tool.result', callId: msg.callId, result });
        try {
          const run = await findLeasedRun(this.prisma, msg.runId, workerId);
          if (!run?.session || run.session.id !== msg.sessionId) {
            return reply({ ok: false, code: 'no_lease', error: 'this worker holds no live lease on that run' });
          }
          const r = await executeTool(this.prisma, this.hub, this.config, { run, session: run.session }, msg.name, msg.args);
          if (!r.ok && r.code === 'max_attempts') this.log.warn({ runId: msg.runId, args: msg.args, error: r.error }, 'review_task reopen refused');
          return reply(r);
        } catch (err) {
          this.log.error({ err, runId: msg.runId, tool: msg.name }, 'tool call failed');
          return reply({ ok: false, code: 'internal_error', error: 'internal error' });
        }
      }
      case 'approval.request': {
        const run = await findLeasedRun(this.prisma, msg.runId, workerId);
        if (!run?.session || run.session.id !== msg.sessionId) {
          // answered, so the worker's run does not wait for a decision that can never come
          return this.send(workerId, {
            type: 'approval.result',
            runId: msg.runId,
            decision: { requestId: msg.request.requestId, decision: 'deny', message: 'no live lease' },
          });
        }
        const decision = await requestApproval(this.prisma, this.hub, { run, session: run.session, request: msg.request });
        if (decision) this.send(workerId, { type: 'approval.result', runId: run.id, decision });
        return;
      }
      case 'run.result': {
        const prior = await this.prisma.taskRun.findUnique({
          where: { id: msg.runId },
          select: { workerId: true, status: true, session: { select: { sdkSessionId: true } } },
        });
        const mine = prior?.workerId === workerId;
        // a stale suspended result: applied, then the run resumed (queued again here) on the same SDK session
        const sdk = msg.result.sdkSessionId;
        if (mine && msg.result.status === 'suspended' && prior.status === 'queued' && sdk && prior.session?.sdkSessionId === sdk) {
          this.send(workerId, { type: 'run.result.ack', runId: msg.runId });
          return;
        }
        // a resend after a lost ack: already final on this worker with the same outcome, so ack without applying it again
        const resend = mine && FINAL_RUN.has(prior.status) && prior.status === msg.result.status;
        if (!resend) await completeRun(this.prisma, this.hub, this.config, { runId: msg.runId, workerId, result: msg.result }, this.log);
        // an owner-cancelled run: the result is not applied, but its usage is owed once
        else if (prior.status === 'cancelled') await recordCancelledUsage(this.prisma, msg.runId, msg.result);
        this.releaseRun(workerId, msg.runId);
        this.send(workerId, { type: 'run.result.ack', runId: msg.runId });
        return;
      }
      case 'integration.check': {
        const run = await findLeasedRun(this.prisma, msg.runId, workerId);
        this.send(workerId, { type: 'integration.allowed', runId: msg.runId, ...(run ? { ok: true } : { ok: false, reason: 'lease lost' }) });
        return;
      }
    }
  }
}
