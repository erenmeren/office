import type { Prisma, PrismaClient } from '@office/db';
import { transitionTask, type TaskStatus } from '@office/shared';
import type { EventHub, TaskStatusChanged } from './event-hub.js';
import type { WorkerGateway } from '../ws/worker-gateway.js';

export type Db = PrismaClient | Prisma.TransactionClient;

export const ACTIVE_RUN_STATUSES = ['queued', 'running', 'waiting_reply', 'waiting_approval'] as const;

export function createTask(
  prisma: Db,
  data: { projectId: string; agentId: string; title: string; description: string; priority?: number },
) {
  // Phase 1 has no dependencies, so every new task is immediately ready.
  return prisma.task.create({ data: { ...data, status: 'ready' } });
}

/** The only writer of Task.status. Throws InvalidTransitionError on an illegal move. */
export async function setTaskStatus(prisma: Db, hub: EventHub, taskId: string, to: TaskStatus) {
  const current = await prisma.task.findUniqueOrThrow({ where: { id: taskId } });
  transitionTask(current.status, to);
  // the status guard makes a concurrent change fail instead of being overwritten
  const task = await prisma.task.update({ where: { id: taskId, status: current.status }, data: { status: to } });
  // shortcut: published before an enclosing transaction commits; a rollback leaves a stale UI update.
  const msg: TaskStatusChanged = {
    type: 'task.status.changed',
    task: { id: task.id, status: task.status, updatedAt: task.updatedAt.toISOString() },
  };
  hub.publish(`task:${task.id}`, msg);
  hub.publish('global', msg);
  return task;
}

export async function cancelTask(prisma: PrismaClient, hub: EventHub, gateway: WorkerGateway, taskId: string) {
  const task = await prisma.task.findUniqueOrThrow({ where: { id: taskId } });
  transitionTask(task.status, 'cancelled'); // fail before touching runs
  const runs = await prisma.taskRun.findMany({ where: { taskId, status: { in: [...ACTIVE_RUN_STATUSES] } } });
  const now = new Date();
  for (const run of runs) {
    await prisma.taskRun.update({ where: { id: run.id }, data: { status: 'cancelled', finishedAt: now } });
    await prisma.agentSession.updateMany({ where: { runId: run.id }, data: { status: 'cancelled', endedAt: now } });
    if (run.workerId) {
      gateway.send(run.workerId, { type: 'run.cancel', runId: run.id });
      gateway.releaseRun(run.workerId, run.id);
    }
    hub.publish(`run:${run.id}`, { type: 'run.status.changed', runId: run.id, status: 'cancelled' });
  }
  return setTaskStatus(prisma, hub, taskId, 'cancelled');
}
