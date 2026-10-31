import type { Prisma, PrismaClient } from '@office/db';
import { transitionTask, type TaskStatus } from '@office/shared';
import type { EventHub, Outbox } from './event-hub.js';
import type { WorkerGateway } from '../ws/worker-gateway.js';

export type Db = PrismaClient | Prisma.TransactionClient;

export function createTask(
  prisma: Db,
  data: { projectId: string; agentId: string; title: string; description: string; priority?: number },
) {
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

export async function cancelTask(prisma: PrismaClient, hub: EventHub, gateway: WorkerGateway, taskId: string) {
  const outbox: Outbox = [];
  const now = new Date();
  const { task, cancelled } = await prisma.$transaction(async (tx) => {
    const current = await tx.task.findUniqueOrThrow({ where: { id: taskId } });
    transitionTask(current.status, 'cancelled'); // fail before touching runs
    const runs = await tx.taskRun.findMany({ where: { taskId, status: { in: ['queued', 'running'] } } });
    const cancelled: typeof runs = [];
    for (const run of runs) {
      // guarded so a run that finishes concurrently keeps its result
      const { count } = await tx.taskRun.updateMany({
        where: { id: run.id, status: { in: ['queued', 'running'] } },
        data: { status: 'cancelled', finishedAt: now },
      });
      if (count === 0) continue;
      await tx.agentSession.updateMany({ where: { runId: run.id }, data: { status: 'cancelled', endedAt: now } });
      outbox.push({
        topic: `run:${run.id}`,
        message: { type: 'run.status.changed', runId: run.id, status: 'cancelled' },
      });
      cancelled.push(run);
    }
    // a running task whose run just finished elsewhere is left to that result
    if (cancelled.length === 0 && current.status === 'running') return { task: current, cancelled };
    return { task: await setTaskStatus(tx, outbox, taskId, 'cancelled'), cancelled };
  });
  hub.publishAll(outbox);
  for (const run of cancelled) {
    if (!run.workerId) continue;
    gateway.send(run.workerId, { type: 'run.cancel', runId: run.id });
    gateway.releaseRun(run.workerId, run.id);
  }
  return task;
}
