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
