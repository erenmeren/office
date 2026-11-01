import type { AgentSession, Prisma, PrismaClient, Task, TaskRun } from '@office/db';
import { RunSpecSchema, skillPromptSection, type OfficeEvent, type RunResult } from '@office/shared';
import { redactSecrets } from '@office/runtime';
import type { Config } from '../config.js';
import type { EventHub, Outbox, RunStatusChanged } from './event-hub.js';
import { loadVersion } from './agent-service.js';
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
): Promise<(TaskRun & { session: AgentSession | null; task: Task | null }) | null> {
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
  const { version, config: cfg, skills, subagents } = await loadVersion(prisma, agent.currentVersionId);
  const section = skillPromptSection(skills);

  const outbox: Outbox = [];
  const created = await prisma.$transaction(async (tx) => {
    const run = await tx.taskRun.create({
      data: {
        taskId: task.id,
        agentId: task.agentId,
        projectId: task.projectId,
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
        skillsSnapshot: skills.map(({ skillId, skillVersionId, name, version, checksum, mode }) => ({
          skillId, skillVersionId, name, version, checksum, mode,
        })),
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
      systemPrompt: cfg.systemPrompt + (section ? '\n\n' + section : ''),
      model: cfg.model,
      effort: cfg.effort,
      allowedTools: cfg.allowedTools,
      maxTurns: cfg.maxTurns,
      maxBudgetUsd: cfg.maxBudgetUsd,
      maxConcurrentSubagents: cfg.maxConcurrentSubagents,
      maxSubagentDepth: cfg.maxSubagentDepth,
      skills: skills.map(({ name, version, checksum, mode, files }) => ({ name, version, checksum, mode, files })),
      subagents,
    });
    return { run, session, spec };
  });
  hub.publishAll(outbox);
  return created;
}

/**
 * queued -> running, guarded on the lease and decided on in-transaction state. If a concurrent
 * accept already moved the run to running this is a no-op; any other state loses the lease.
 */
async function acceptRunInTx(tx: Prisma.TransactionClient, outbox: Outbox, runId: string, workerId: string, now: Date) {
  const { count } = await tx.taskRun.updateMany({
    where: { id: runId, workerId, status: 'queued', leaseExpiresAt: { gt: now } },
    data: { status: 'running', startedAt: now },
  });
  if (count === 0) {
    if ((await tx.taskRun.findUnique({ where: { id: runId } }))?.status === 'running') return;
    throw new LeaseError(runId);
  }
  await tx.agentSession.updateMany({ where: { runId }, data: { status: 'running' } });
  const run = await tx.taskRun.findUniqueOrThrow({ where: { id: runId }, include: { task: true } });
  if (run.task!.status !== 'running') await setTaskStatus(tx, outbox, run.taskId!, 'running');
  queueRunStatus(outbox, runId, 'running');
}

/** A queued run whose assignment never reached the worker: lost, and its task is ready again without using an attempt. */
export async function abandonRun(prisma: PrismaClient, hub: EventHub, runId: string) {
  const now = new Date();
  const outbox: Outbox = [];
  await prisma.$transaction(async (tx) => {
    const { count } = await tx.taskRun.updateMany({
      where: { id: runId, status: 'queued' },
      data: { status: 'lost', finishedAt: now, error: 'assignment not delivered to the worker' },
    });
    if (count === 0) return;
    await tx.agentSession.updateMany({ where: { runId }, data: { status: 'lost', endedAt: now } });
    const run = await tx.taskRun.findUniqueOrThrow({ where: { id: runId } });
    await tx.task.update({ where: { id: run.taskId! }, data: { attempts: { decrement: 1 } } });
    await setTaskStatus(tx, outbox, run.taskId!, 'ready');
    queueRunStatus(outbox, runId, 'lost');
  });
  hub.publishAll(outbox);
}

export async function markRunning(prisma: PrismaClient, hub: EventHub, runId: string, workerId: string) {
  const run = await findLeasedRun(prisma, runId, workerId);
  if (!run) throw new LeaseError(runId);
  const outbox: Outbox = [];
  await prisma.$transaction((tx) => acceptRunInTx(tx, outbox, runId, workerId, new Date()));
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
  // 'suspended' results are wired up in a later Phase 3 task; map to waiting_reply meanwhile
  const status = r.status === 'suspended' ? 'waiting_reply' : r.status;
  const now = new Date();
  const outbox: Outbox = [];
  await prisma.$transaction(async (tx) => {
    // run.accepted never reached us (e.g. socket dropped): accept implicitly so the result is not lost
    if (run.status === 'queued') await acceptRunInTx(tx, outbox, runId, workerId, now);
    // guarded again here so a lease expiring between the check and the write still loses
    const { count } = await tx.taskRun.updateMany({
      where: { id: runId, status: { in: [...LEASED] }, leaseExpiresAt: { gt: now } },
      data: {
        status,
        resultText: r.resultText,
        error: r.error,
        finishedAt: now,
        costUsd: r.usage.costUsd,
      },
    });
    if (count === 0) throw new LeaseError(runId);
    await tx.agentSession.update({
      where: { id: run.session!.id },
      data: { status, sdkSessionId: r.sdkSessionId, endedAt: now },
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
    if (status === 'succeeded') {
      // Phase 1 auto-closes review; the Chief takes it over in Phase 4.
      await setTaskStatus(tx, outbox, run.taskId!, 'review');
      await setTaskStatus(tx, outbox, run.taskId!, 'done');
    } else {
      await setTaskStatus(tx, outbox, run.taskId!, status);
    }
    queueRunStatus(outbox, runId, status);
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
      const task = await tx.task.findUniqueOrThrow({ where: { id: run.taskId! } });
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
