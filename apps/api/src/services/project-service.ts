import type { Agent, Prisma, PrismaClient } from '@office/db';
import { ProjectSettingsSchema, type ProjectSettings } from '@office/shared';
import { HttpError } from '../lib/errors.js';

type Db = PrismaClient | Prisma.TransactionClient;

async function project(db: Db, id: string) {
  const p = await db.project.findUnique({ where: { id } });
  if (!p) throw new HttpError(404, 'not_found');
  return p;
}

export async function getSettings(db: Db, projectId: string): Promise<ProjectSettings> {
  return ProjectSettingsSchema.parse((await project(db, projectId)).settings ?? {});
}

// Shallow merge: approvalPolicy and envTemplate in the patch replace the stored value whole.
export async function updateSettings(db: Db, projectId: string, patch: Partial<ProjectSettings>): Promise<ProjectSettings> {
  const stored = ((await project(db, projectId)).settings ?? {}) as Record<string, unknown>;
  const next = ProjectSettingsSchema.parse({ ...stored, ...patch });
  await db.project.update({ where: { id: projectId }, data: { settings: next } });
  return next;
}

export async function projectAgents(db: Db, projectId: string): Promise<Agent[]> {
  const rows = await db.projectAgent.findMany({ where: { projectId }, include: { agent: true }, orderBy: { agent: { name: 'asc' } } });
  return rows.map((r) => r.agent);
}

export async function setProjectAgents(db: PrismaClient, projectId: string, agentIds: string[]): Promise<Agent[]> {
  await project(db, projectId);
  const ids = [...new Set(agentIds)];
  const agents = await db.agent.findMany({ where: { id: { in: ids }, isActive: true, isSystem: false } });
  if (agents.length !== ids.length) throw new HttpError(400, 'invalid_agent');
  await db.$transaction([
    db.projectAgent.deleteMany({ where: { projectId, agentId: { notIn: ids } } }),
    db.projectAgent.createMany({ data: ids.map((agentId) => ({ projectId, agentId })), skipDuplicates: true }),
  ]);
  return projectAgents(db, projectId);
}

export async function agentAllowed(db: Db, projectId: string, agentId: string): Promise<boolean> {
  if ((await db.projectAgent.count({ where: { projectId } })) === 0) return true;
  return (await db.projectAgent.count({ where: { projectId, agentId } })) > 0;
}

const LIVE_RUN = ['queued', 'running', 'waiting_approval', 'waiting_reply'] as const;
const LIVE_MISSION = ['planning', 'awaiting_approval', 'approved', 'running', 'review'] as const;

/**
 * Removes a project with everything it owns (missions, tasks, runs, sessions and their events, approvals, artifacts,
 * conversations, memory, usage, manual sessions). Refused while a run or a mission is live. The repository on disk stays.
 */
export async function deleteProject(db: PrismaClient, projectId: string): Promise<{ slug: string }> {
  const project = await db.project.findUnique({ where: { id: projectId }, select: { slug: true } });
  if (!project) throw new HttpError(404, 'not_found');
  const [liveRuns, liveMissions] = await Promise.all([
    db.taskRun.count({ where: { projectId, status: { in: [...LIVE_RUN] } } }),
    db.mission.count({ where: { projectId, status: { in: [...LIVE_MISSION] } } }),
  ]);
  if (liveRuns || liveMissions) {
    throw new HttpError(409, 'project_in_use', `${liveMissions} mission(s) and ${liveRuns} run(s) are still live; cancel them first`);
  }
  await db.$transaction(async (tx) => {
    const sessionIds = (await tx.agentSession.findMany({ where: { projectId }, select: { id: true } })).map((s) => s.id);
    const runIds = (await tx.taskRun.findMany({ where: { projectId }, select: { id: true } })).map((r) => r.id);
    const messageIds = (await tx.message.findMany({ where: { projectId }, select: { id: true } })).map((m) => m.id);
    const memoryIds = (await tx.memoryEntry.findMany({ where: { projectId }, select: { id: true } })).map((m) => m.id);
    const taskIds = (await tx.task.findMany({ where: { projectId }, select: { id: true } })).map((t) => t.id);
    await tx.sessionEvent.deleteMany({ where: { sessionId: { in: sessionIds } } });
    await tx.subagentRun.deleteMany({ where: { sessionId: { in: sessionIds } } });
    await tx.usageRecord.deleteMany({ where: { projectId } });
    await tx.checkResult.deleteMany({ where: { runId: { in: runIds } } });
    await tx.gitWorkspace.deleteMany({ where: { runId: { in: runIds } } });
    await tx.agentSession.deleteMany({ where: { projectId } });
    await tx.approval.deleteMany({ where: { projectId } });
    await tx.messageDelivery.deleteMany({ where: { messageId: { in: messageIds } } });
    await tx.message.deleteMany({ where: { projectId } });
    await tx.conversation.deleteMany({ where: { projectId } });
    await tx.memorySource.deleteMany({ where: { memoryEntryId: { in: memoryIds } } });
    await tx.memoryEntry.deleteMany({ where: { projectId } });
    await tx.artifact.deleteMany({ where: { projectId } });
    await tx.manualSession.deleteMany({ where: { projectId } });
    await tx.taskRun.deleteMany({ where: { projectId } });
    await tx.taskDependency.deleteMany({ where: { OR: [{ taskId: { in: taskIds } }, { dependsOnId: { in: taskIds } }] } });
    await tx.task.deleteMany({ where: { projectId } });
    await tx.mission.deleteMany({ where: { projectId } });
    await tx.projectAgent.deleteMany({ where: { projectId } });
    await tx.project.delete({ where: { id: projectId } });
  });
  return project;
}
