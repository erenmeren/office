import type { AgentSession, PrismaClient, Task, TaskRun } from '@office/db';
import { AgentConfigSchema, RunSpecSchema, type OfficeEvent, type RunResult } from '@office/shared';
import { redactSecrets } from '@office/runtime';
import type { Config } from '../config.js';
import type { EventHub, Outbox, RunStatusChanged } from './event-hub.js';
import { appendEvent } from './event-store.js';
import { setTaskStatus } from './task-service.js';

export class LeaseError extends Error {
  constructor(runId: string) {
    super(`No live lease for run ${runId} on this worker`);
    this.name = 'LeaseError';
  }
}

const LEASED = ['queued', 'running'] as const;
const leaseUntil = (config: Config) => new Date(Date.now() + config.leaseSeconds * 1000);

function queueRunStatus(outbox: Outbox, runId: string, status: RunStatusChanged['status']) {
  outbox.push({ topic: `run:${runId}`, message: { type: 'run.status.changed', runId, status } });
}

/** The run if `workerId` owns it with a live lease, else null. */
export function findLeasedRun(
  prisma: PrismaClient,
  runId: string,
  workerId: string,
): Promise<(TaskRun & { session: AgentSession | null; task: Task }) | null> {
  return prisma.taskRun.findFirst({
    where: { id: runId, workerId, status: { in: [...LEASED] }, leaseExpiresAt: { gt: new Date() } },
    include: { session: true, task: true },
  });
}

export async function createRunForTask(
  prisma: PrismaClient,
  hub: EventHub,
  task: Task,
  worker: { workerId: string },
  config: Config,
) {
  const [agent, project] = await Promise.all([
    prisma.agent.findUniqueOrThrow({ where: { id: task.agentId } }),
    prisma.project.findUniqueOrThrow({ where: { id: task.projectId } }),
  ]);
  if (!agent.currentVersionId) throw new Error(`Agent ${agent.id} has no current version`);
  const version = await prisma.agentVersion.findUniqueOrThrow({ where: { id: agent.currentVersionId } });
  const cfg = AgentConfigSchema.parse(version.config);

  const outbox: Outbox = [];
  const created = await prisma.$transaction(async (tx) => {
    const run = await tx.taskRun.create({
      data: {
        taskId: task.id,
        agentVersionId: version.id,
        workerId: worker.workerId,
        status: 'queued',
        leaseExpiresAt: leaseUntil(config),
      },
    });
    const session = await tx.agentSession.create({
      data: {
        runId: run.id,
        agentId: task.agentId,
        projectId: task.projectId,
        model: cfg.model,
        status: 'starting',
        startedAt: new Date(),
      },
    });
    await tx.task.update({ where: { id: task.id }, data: { attempts: { increment: 1 } } });
    await setTaskStatus(tx, outbox, task.id, 'queued');
    const spec = RunSpecSchema.parse({
      runId: run.id,
      sessionId: session.id,
      agentId: task.agentId,
      projectId: task.projectId,
      cwd: project.repoPath,
      prompt: `${task.title}\n\n${task.description}`,
      systemPrompt: cfg.systemPrompt,
      model: cfg.model,
      effort: cfg.effort,
      allowedTools: cfg.allowedTools,
      maxTurns: cfg.maxTurns,
      maxBudgetUsd: cfg.maxBudgetUsd,
      maxConcurrentSubagents: cfg.maxConcurrentSubagents,
      maxSubagentDepth: cfg.maxSubagentDepth,
    });
    return { run, session, spec };
  });
  hub.publishAll(outbox);
  return created;
}

export async function markRunning(prisma: PrismaClient, hub: EventHub, runId: string, workerId: string) {
  const run = await findLeasedRun(prisma, runId, workerId);
  if (!run) throw new LeaseError(runId);
  const outbox: Outbox = [];
  await prisma.$transaction(async (tx) => {
    await tx.taskRun.update({ where: { id: runId }, data: { status: 'running', startedAt: new Date() } });
    await tx.agentSession.updateMany({ where: { runId }, data: { status: 'running' } });
    if (run.task.status !== 'running') await setTaskStatus(tx, outbox, run.taskId, 'running');
    queueRunStatus(outbox, runId, 'running');
  });
  hub.publishAll(outbox);
}

export async function renewLeases(prisma: PrismaClient, workerId: string, runIds: string[], config: Config) {
  await prisma.taskRun.updateMany({
    where: { id: { in: runIds }, workerId, status: { in: [...LEASED] } },
    data: { leaseExpiresAt: leaseUntil(config) },
  });
}

export async function completeRun(
  prisma: PrismaClient,
  hub: EventHub,
  { runId, workerId, result }: { runId: string; workerId: string; result: RunResult },
) {
  const run = await findLeasedRun(prisma, runId, workerId);
  if (!run || !run.session) throw new LeaseError(runId);
  const r = redactSecrets(result);
  const now = new Date();
  const outbox: Outbox = [];
  await prisma.$transaction(async (tx) => {
    // guarded again here so a lease expiring between the check and the write still loses
    const { count } = await tx.taskRun.updateMany({
      where: { id: runId, status: { in: [...LEASED] }, leaseExpiresAt: { gt: now } },
      data: {
        status: r.status,
        resultText: r.resultText,
        error: r.error,
        finishedAt: now,
        costUsd: r.usage.costUsd,
      },
    });
    if (count === 0) throw new LeaseError(runId);
    await tx.agentSession.update({
      where: { id: run.session!.id },
      data: { status: r.status, sdkSessionId: r.sdkSessionId, endedAt: now },
    });
    await tx.usageRecord.create({
      data: {
        runId,
        projectId: run.session!.projectId,
        agentId: run.session!.agentId,
        model: run.session!.model,
        inputTokens: r.usage.inputTokens,
        outputTokens: r.usage.outputTokens,
        costUsd: r.usage.costUsd,
      },
    });
    if (r.status === 'succeeded') {
      // Phase 1 auto-closes review; the Chief takes it over in Phase 4.
      await setTaskStatus(tx, outbox, run.taskId, 'review');
      await setTaskStatus(tx, outbox, run.taskId, 'done');
    } else {
      await setTaskStatus(tx, outbox, run.taskId, r.status);
    }
    queueRunStatus(outbox, runId, r.status);
  });
  hub.publishAll(outbox);
}

/** Marks every expired leased run `lost` and requeues or fails its task. Returns the lost runs. */
export async function expireLeases(prisma: PrismaClient, hub: EventHub, now = new Date()) {
  const expired = await prisma.taskRun.findMany({
    where: { status: { in: [...LEASED] }, leaseExpiresAt: { lt: now } },
    include: { session: true },
  });
  const lost: Array<{ runId: string; workerId: string | null }> = [];
  for (const run of expired) {
    const outbox: Outbox = [];
    const changed = await prisma.$transaction(async (tx) => {
      // re-check inside the transaction so a concurrent result or renewal wins
      const { count } = await tx.taskRun.updateMany({
        where: { id: run.id, status: { in: [...LEASED] }, leaseExpiresAt: { lt: now } },
        data: { status: 'lost', finishedAt: now },
      });
      if (count === 0) return false;
      if (run.session) {
        await tx.agentSession.update({ where: { id: run.session.id }, data: { status: 'lost', endedAt: now } });
      }
      const task = await tx.task.findUniqueOrThrow({ where: { id: run.taskId } });
      await setTaskStatus(tx, outbox, task.id, task.attempts < task.maxAttempts ? 'ready' : 'failed');
      queueRunStatus(outbox, run.id, 'lost');
      return true;
    });
    if (!changed) continue;
    hub.publishAll(outbox);
    lost.push({ runId: run.id, workerId: run.workerId });
    if (run.session) {
      const max = await prisma.sessionEvent.aggregate({ where: { sessionId: run.session.id }, _max: { seq: true } });
      const event: OfficeEvent = {
        type: 'run.lease.lost',
        seq: (max._max.seq ?? 0) + 1,
        ts: now.toISOString(),
        sessionId: run.session.id,
        runId: run.id,
        agentId: run.session.agentId,
        projectId: run.session.projectId,
        payload: { workerId: run.workerId },
      };
      if ((await appendEvent(prisma, event)).inserted) hub.publish(`run:${run.id}`, event);
    }
  }
  return lost;
}
