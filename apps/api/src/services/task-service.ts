import type { Prisma, PrismaClient } from '@office/db';
import { transitionTask, type TaskStatus } from '@office/shared';
import type { EventHub, Outbox } from './event-hub.js';
import type { WorkerGateway } from '../ws/worker-gateway.js';
import { HttpError } from '../lib/errors.js';

export type Db = PrismaClient | Prisma.TransactionClient;

export async function createTask(
  prisma: Db,
  data: { projectId: string; agentId: string; title: string; description: string; priority?: number },
) {
  const agent = await prisma.agent.findUnique({ where: { id: data.agentId } });
  // system agents (office-summarizer) and inactive agents never take owner tasks
  if (!agent || agent.isSystem || !agent.isActive) throw new HttpError(400, 'invalid_agent');
  // Phase 1 has no dependencies, so every new task is immediately ready.
  return prisma.task.create({ data: { ...data, status: 'ready' } });
}

/**
 * The only writer of Task.status. Throws InvalidTransitionError on an illegal move.
 * Queues `task.status.changed` in `outbox`; the caller publishes it after its transaction commits.
 */
export async function setTaskStatus(db: Db, outbox: Outbox, taskId: string, to: TaskStatus) {
  const current = await db.task.findUniqueOrThrow({ where: { id: taskId } });
  transitionTask(current.status, to);
  // the status guard makes a concurrent change fail instead of being overwritten
  const task = await db.task.update({ where: { id: taskId, status: current.status }, data: { status: to } });
  const message = {
    type: 'task.status.changed' as const,
    task: { id: task.id, status: task.status, updatedAt: task.updatedAt.toISOString() },
  };
  outbox.push({ topic: `task:${task.id}`, message }, { topic: 'global', message });
  return task;
}

const LIVE_RUN = ['queued', 'running', 'waiting_reply'] as const;

/** Cancels the live runs matching `where` (guarded, so a run finishing concurrently keeps its result). */
export async function cancelLiveRuns(tx: Prisma.TransactionClient, outbox: Outbox, where: Prisma.TaskRunWhereInput) {
  const now = new Date();
  const runs = await tx.taskRun.findMany({ where: { ...where, status: { in: [...LIVE_RUN] } } });
  const cancelled: typeof runs = [];
  for (const run of runs) {
    const { count } = await tx.taskRun.updateMany({
      where: { id: run.id, status: { in: [...LIVE_RUN] } },
      data: { status: 'cancelled', finishedAt: now },
    });
    if (count === 0) continue;
    await tx.agentSession.updateMany({ where: { runId: run.id }, data: { status: 'cancelled', endedAt: now } });
    outbox.push({ topic: `run:${run.id}`, message: { type: 'run.status.changed', runId: run.id, status: 'cancelled' } });
    cancelled.push(run);
  }
  return cancelled;
}

/** Tells each worker to stop the cancelled runs it holds; call after the transaction commits. */
export function notifyCancelled(gateway: WorkerGateway, runs: Array<{ id: string; workerId: string | null; status: string }>) {
  for (const run of runs) {
    // a waiting run holds no worker slot
    if (!run.workerId || run.status === 'waiting_reply') continue;
    gateway.send(run.workerId, { type: 'run.cancel', runId: run.id });
    gateway.releaseRun(run.workerId, run.id);
  }
}

export async function cancelTask(prisma: PrismaClient, hub: EventHub, gateway: WorkerGateway, taskId: string) {
  const outbox: Outbox = [];
  const { task, cancelled } = await prisma.$transaction(async (tx) => {
    const current = await tx.task.findUniqueOrThrow({ where: { id: taskId } });
    transitionTask(current.status, 'cancelled'); // fail before touching runs
    const cancelled = await cancelLiveRuns(tx, outbox, { taskId, kind: 'task' });
    // a running task whose run just finished elsewhere is left to that result
    if (cancelled.length === 0 && current.status === 'running') return { task: current, cancelled };
    return { task: await setTaskStatus(tx, outbox, taskId, 'cancelled'), cancelled };
  });
  hub.publishAll(outbox);
  notifyCancelled(gateway, cancelled);
  return task;
}
