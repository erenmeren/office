import type { Agent, PrismaClient, Task } from '@office/db';
import type { ProjectSettings } from '@office/shared';
import { HttpError } from '../lib/errors.js';
import { audit } from './audit-service.js';
import type { EventHub, Outbox } from './event-hub.js';
import { queueApproval } from './mission-service.js';
import { agentAllowed } from './project-service.js';
import type { Db } from './task-service.js';

const LIVE_RUN = ['queued', 'running', 'waiting_reply', 'waiting_approval'] as const;

export const utcMidnight = (now = new Date()) =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

/** UsageRecord cost since UTC midnight for an agent and/or a project. */
export async function spentToday(db: Db, where: { agentId?: string; projectId?: string }) {
  const r = await db.usageRecord.aggregate({ where: { ...where, createdAt: { gte: utcMidnight() } }, _sum: { costUsd: true } });
  return r._sum.costUsd ?? 0;
}

/** Total cost of every run of the mission (plan, tasks, reviews). */
export async function missionSpent(db: Db, missionId: string) {
  const r = await db.usageRecord.aggregate({ where: { run: { missionId } }, _sum: { costUsd: true } });
  return r._sum.costUsd ?? 0;
}

/** The project's daily budget, raised by one more daily budget per budget_exceeded approval decided today. */
export async function dailyLimit(db: Db, settings: ProjectSettings, projectId: string) {
  const approved = await db.approval.count({
    where: { projectId, type: 'budget_exceeded', status: 'approved', decidedAt: { gte: utcMidnight() } },
  });
  return settings.dailyBudgetUsd * (1 + approved);
}

/** Runs holding a session: queued, running or waiting. */
export const runningCount = (db: Db, where: { agentId?: string; projectId?: string }): Promise<number> =>
  db.taskRun.count({ where: { ...where, status: { in: [...LIVE_RUN] } } });

export type Gate = { ok: true } | { ok: false; reason: string; budgetExceeded?: true };

/** Whether a ready task may start now; the first failing rule is the reason. */
export async function gate(db: Db, settings: ProjectSettings, task: Task, agent: Agent): Promise<Gate> {
  if (!(await agentAllowed(db, task.projectId, agent.id))) return { ok: false, reason: 'agent not allowed in the project' };
  if (!agent.isActive) return { ok: false, reason: 'agent inactive' };
  if ((await runningCount(db, { agentId: agent.id })) >= agent.maxConcurrentSessions) {
    return { ok: false, reason: 'agent at maxConcurrentSessions' };
  }
  if (agent.dailyBudgetUsd != null && (await spentToday(db, { agentId: agent.id })) >= agent.dailyBudgetUsd) {
    return { ok: false, reason: 'agent daily budget spent' };
  }
  const mission = task.missionId ? await db.mission.findUnique({ where: { id: task.missionId } }) : null;
  if (mission?.budgetUsd != null && (await missionSpent(db, mission.id)) >= mission.budgetUsd) {
    return { ok: false, reason: 'mission budget exhausted', budgetExceeded: true };
  }
  if ((await spentToday(db, { projectId: task.projectId })) >= (await dailyLimit(db, settings, task.projectId))) {
    return { ok: false, reason: 'project daily budget spent', budgetExceeded: true };
  }
  if ((await runningCount(db, { projectId: task.projectId })) >= settings.maxConcurrentRuns) {
    return { ok: false, reason: 'project at maxConcurrentRuns' };
  }
  return { ok: true };
}

/** One budget_exceeded approval per mission, reason and UTC day (none when one was already raised today). */
export async function requestBudgetApproval(prisma: PrismaClient, hub: EventHub, missionId: string, reason: string) {
  const outbox: Outbox = [];
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`budget:${missionId}`}))::text`;
    const exists = await tx.approval.count({
      where: { missionId, reason, type: 'budget_exceeded', status: { in: ['pending', 'approved'] }, createdAt: { gte: utcMidnight() } },
    });
    if (exists) return;
    const mission = await tx.mission.findUniqueOrThrow({ where: { id: missionId } });
    const approval = await tx.approval.create({
      data: { projectId: mission.projectId, missionId, type: 'budget_exceeded', status: 'pending', reason },
    });
    queueApproval(outbox, approval);
  });
  hub.publishAll(outbox);
}

/** Approves a pending budget_exceeded approval; dailyLimit counts it, raising today's project budget. */
export async function approveBudget(prisma: PrismaClient, hub: EventHub, approvalId: string, userId: string) {
  const outbox: Outbox = [];
  const approval = await prisma.$transaction(async (tx) => {
    const a = await tx.approval.findUnique({ where: { id: approvalId } });
    if (!a) throw new HttpError(404, 'not_found');
    if (a.type !== 'budget_exceeded' || !a.missionId) throw new HttpError(409, 'unsupported_approval_type');
    const { count } = await tx.approval.updateMany({
      where: { id: approvalId, status: 'pending' },
      data: { status: 'approved', decidedAt: new Date(), decidedByUserId: userId },
    });
    if (count === 0) throw new HttpError(409, 'already_decided');
    await audit(tx, { userId, action: 'budget.approved', targetType: 'mission', targetId: a.missionId, detail: { approvalId } });
    const decided = await tx.approval.findUniqueOrThrow({ where: { id: approvalId } });
    queueApproval(outbox, decided);
    return decided;
  });
  hub.publishAll(outbox);
  return approval;
}
