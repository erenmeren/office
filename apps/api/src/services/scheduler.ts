import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import type { PrismaClient } from '@office/db';
import type { RunSpec } from '@office/shared';
import type { Config } from '../config.js';
import { isUnderRoot } from '../lib/paths.js';
import type { WorkerGateway } from '../ws/worker-gateway.js';
import type { EventHub } from './event-hub.js';
import { pendingWakeDeliveries } from './message-service.js';
import { abandonRun, createRun, createRunForTask, expireLeases, resumeRun } from './run-service.js';
import { summaryPrompt } from './summary-prompt.js';

const SUMMARIZER_SLUG = 'office-summarizer';
const WAKE_PROMPT = 'You have new messages. Read your inbox and answer.';

// worker roots are real paths, so compare the repo's real path too (resolve only if it does not exist here)
function realOrResolved(path: string) {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

export class Scheduler {
  private timer?: NodeJS.Timeout;
  private inFlight?: Promise<void>;
  // ready tasks already warned about having no eligible worker
  private warnedNoWorker = new Set<string>();
  private warnedNoSummarizer = false;

  constructor(
    private prisma: PrismaClient,
    private hub: EventHub,
    private gateway: WorkerGateway,
    private config: Config,
    private log: FastifyBaseLogger,
  ) {}

  /** `schedulerIntervalMs: 0` means "do not start the timer" (tests call tick() directly). */
  start() {
    if (this.config.schedulerIntervalMs > 0 && !this.timer) {
      this.timer = setInterval(() => void this.tick(), this.config.schedulerIntervalMs);
    }
  }

  async stop() {
    clearInterval(this.timer);
    this.timer = undefined;
    await this.inFlight;
  }

  /** Overlapping calls share the tick already in flight. */
  tick(): Promise<void> {
    this.inFlight ??= this.run().finally(() => (this.inFlight = undefined));
    return this.inFlight;
  }

  private async run() {
    try {
      for (const { runId, workerId } of await expireLeases(this.prisma, this.hub)) {
        if (!workerId) continue;
        // the worker may still be executing it; it must stop touching the repo
        this.gateway.send(workerId, { type: 'run.cancel', runId });
        this.gateway.releaseRun(workerId, runId);
      }
    } catch (err) {
      this.log.error({ err }, 'expireLeases failed');
    }
    let tasks;
    try {
      tasks = await this.prisma.task.findMany({
        where: { status: 'ready' },
        orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
        include: { project: true },
      });
    } catch (err) {
      this.log.error({ err }, 'scheduler could not list ready tasks');
      return;
    }
    for (const task of tasks) {
      try {
        const worker = this.pickWorker(task.project.repoPath);
        if (!worker) {
          if (!this.warnedNoWorker.has(task.id)) {
            this.warnedNoWorker.add(task.id);
            this.log.warn({ taskId: task.id, repoPath: task.project.repoPath }, 'ready task has no eligible worker online');
          }
          continue;
        }
        this.warnedNoWorker.delete(task.id);
        const { spec } = await createRunForTask(this.prisma, this.hub, task, worker, this.config);
        await this.assign(worker.workerId, spec);
      } catch (err) {
        this.log.error({ err, taskId: task.id }, 'scheduling task failed');
      }
    }
    try {
      await this.resumeWaiting();
    } catch (err) {
      this.log.error({ err }, 'resuming waiting runs failed');
    }
    try {
      await this.wakeAgents();
    } catch (err) {
      this.log.error({ err }, 'waking agents failed');
    }
    try {
      await this.summarize();
    } catch (err) {
      this.log.error({ err }, 'enqueuing summary runs failed');
    }
  }

  /** A worker with a free slot whose allowedRoots cover the repo. */
  private pickWorker(repoPath: string) {
    const real = realOrResolved(repoPath);
    return this.gateway
      .onlineWorkers()
      .find((w) => w.capacity - w.activeRuns > 0 && w.allowedRoots.some((r) => isUnderRoot(real, r)));
  }

  private async assign(workerId: string, spec: RunSpec) {
    if (this.gateway.send(workerId, { type: 'run.assign', spec })) return true;
    this.log.warn({ runId: spec.runId, workerId }, 'run.assign not delivered; run released');
    await abandonRun(this.prisma, this.hub, spec.runId);
    return false;
  }

  /** waiting_reply runs whose reply arrived or whose wait timed out go back to a worker. */
  private async resumeWaiting() {
    const cutoff = new Date(Date.now() - this.config.replyTimeoutMinutes * 60_000);
    const waiting = await this.prisma.taskRun.findMany({ where: { status: 'waiting_reply' }, include: { project: true } });
    for (const run of waiting) {
      try {
        const reply = run.waitingForMessageId
          ? await this.prisma.message.findFirst({
              where: { type: 'reply', inReplyToId: run.waitingForMessageId },
              orderBy: { createdAt: 'asc' },
            })
          : null;
        if (!reply && !(run.waitingSince && run.waitingSince < cutoff)) continue;
        const worker = this.pickWorker(run.project.repoPath);
        if (!worker) continue;
        let sender = 'owner';
        if (reply?.senderAgentId) {
          sender = (await this.prisma.agent.findUnique({ where: { id: reply.senderAgentId } }))?.slug ?? 'unknown';
        }
        await resumeRun(
          this.prisma,
          this.hub,
          this.config,
          this.gateway,
          run.id,
          reply
            ? { reason: 'reply', reply: { id: reply.id, body: reply.body, sender }, worker }
            : { reason: 'timeout', worker },
          this.log,
        );
      } catch (err) {
        this.log.error({ err, runId: run.id }, 'resuming run failed');
      }
    }
  }

  /**
   * An idle agent with pending wake mail gets an inbox run, or a chat run for an owner (`human`) conversation.
   * Delivery status is left to read_inbox; instead each delivery allows at most two wake runs created after it
   * (one retry after a lost, failed or unread attempt). Untried deliveries go first, then the oldest.
   */
  private async wakeAgents() {
    for (const wake of await pendingWakeDeliveries(this.prisma)) {
      try {
        const agent = await this.prisma.agent.findUnique({ where: { id: wake.agentId } });
        if (!agent || agent.isSystem || !agent.isActive) continue;
        const scope = { agentId: wake.agentId, projectId: wake.projectId };
        const busy = await this.prisma.taskRun.count({
          where: { ...scope, status: { in: ['queued', 'running', 'waiting_reply'] } },
        });
        if (busy) continue;
        // shortcut: one count per pending delivery; fine for small inboxes, batch it if inboxes grow large
        const tried = await Promise.all(
          wake.deliveries.map(async (d) => {
            const human = d.conversationKind === 'human';
            const attempts = await this.prisma.taskRun.count({
              where: {
                ...scope,
                createdAt: { gt: d.createdAt },
                // an inbox run covers agent mail; owner mail is answered by a chat run in its conversation
                ...(human ? { kind: 'chat', conversationId: d.conversationId } : { kind: 'inbox' }),
              },
            });
            return { d, human, attempts };
          }),
        );
        const next = tried
          .filter((x) => x.attempts < 2)
          .sort((x, y) => x.attempts - y.attempts || x.d.createdAt.getTime() - y.d.createdAt.getTime())[0];
        if (!next) continue;
        const [project, conversation] = await Promise.all([
          this.prisma.project.findUniqueOrThrow({ where: { id: wake.projectId } }),
          this.prisma.conversation.findUniqueOrThrow({ where: { id: next.d.conversationId } }),
        ]);
        const worker = this.pickWorker(project.repoPath);
        if (!worker) continue;
        const { spec } = await createRun(this.prisma, this.hub, this.config, {
          kind: next.human ? 'chat' : 'inbox',
          ...scope,
          conversationId: conversation.id,
          resumeSdkSessionId: next.human ? (conversation.sdkSessionId ?? undefined) : undefined,
          prompt: WAKE_PROMPT,
          worker,
        });
        await this.assign(worker.workerId, spec);
      } catch (err) {
        this.log.error({ err, agentId: wake.agentId }, 'waking agent failed');
      }
    }
  }

  /** Each finished task run gets one summary run for the hidden summarizer agent. */
  private async summarize() {
    const due = await this.prisma.taskRun.findMany({
      where: { kind: 'task', status: { in: ['succeeded', 'failed'] }, summarizedAt: null },
      include: { project: true },
      orderBy: { createdAt: 'asc' },
    });
    if (due.length === 0) return;
    const summarizer = await this.prisma.agent.findUnique({ where: { slug: SUMMARIZER_SLUG } });
    if (!summarizer?.currentVersionId || !summarizer.isActive) {
      // left unsummarized so they are picked up once the summarizer is seeded
      if (!this.warnedNoSummarizer) {
        this.warnedNoSummarizer = true;
        this.log.warn({ slug: SUMMARIZER_SLUG }, 'no active summarizer agent; finished runs wait for one');
      }
      return;
    }
    for (const run of due) {
      try {
        const worker = this.pickWorker(run.project.repoPath);
        if (!worker) continue;
        // claim first so a concurrent scheduler cannot enqueue a second summary
        const { count } = await this.prisma.taskRun.updateMany({
          where: { id: run.id, summarizedAt: null },
          data: { summarizedAt: new Date() },
        });
        if (count === 0) continue;
        let spec: RunSpec;
        try {
          ({ spec } = await createRun(this.prisma, this.hub, this.config, {
            kind: 'summary',
            agentId: summarizer.id,
            projectId: run.projectId,
            taskId: run.taskId ?? undefined,
            summaryOfRunId: run.id,
            prompt: await summaryPrompt(this.prisma, run),
            worker,
          }));
        } catch (err) {
          await this.prisma.taskRun.update({ where: { id: run.id }, data: { summarizedAt: null } });
          throw err;
        }
        await this.assign(worker.workerId, spec);
      } catch (err) {
        this.log.error({ err, runId: run.id }, 'enqueuing summary run failed');
      }
    }
  }
}
