import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { PrismaClient, TaskRun } from '@office/db';
import { CONDUCTOR_SLUG } from '@office/shared';
import type { Config } from '../config.js';
import { initRepository } from '../routes/projects.js';
import { audit } from './audit-service.js';
import type { EventHub } from './event-hub.js';
import { findOrCreateConversation } from './message-service.js';
import { createMission } from './mission-service.js';
import { projectDecisions, searchMemory } from './memory-service.js';
import { projectAgents } from './project-service.js';

export { CONDUCTOR_SLUG } from '@office/shared';
export const CONDUCTOR_PROJECT_SLUG = 'office-conductor';

const LIVE_MISSION = ['planning', 'plan_failed', 'awaiting_approval', 'approved', 'running', 'review'] as const;

export class ConductorToolError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

/**
 * The Conductor's hidden home project (created on first use) and its agent (seeded from templates/agents/conductor.json).
 * Runs, conversations and messages need a project; the home project is that, and holds no code.
 */
export async function conductorHome(prisma: PrismaClient, config: Config) {
  let project = await prisma.project.findUnique({ where: { slug: CONDUCTOR_PROJECT_SLUG } });
  if (!project) {
    const repoPath = resolve(config.dataDir, 'repos', CONDUCTOR_PROJECT_SLUG);
    if (!existsSync(join(repoPath, '.git'))) await initRepository(repoPath, 'main', 'Office Conductor', true);
    project = await prisma.project
      .create({ data: { name: 'Office Conductor', slug: CONDUCTOR_PROJECT_SLUG, repoPath, isSystem: true } })
      // a concurrent first call created it
      .catch(() => prisma.project.findUniqueOrThrow({ where: { slug: CONDUCTOR_PROJECT_SLUG } }));
  }
  const agent = await prisma.agent.findUnique({ where: { slug: CONDUCTOR_SLUG } });
  if (!agent?.isActive || !agent.currentVersionId) return { project, agent: null, conversation: null };
  await prisma.projectAgent.upsert({
    where: { projectId_agentId: { projectId: project.id, agentId: agent.id } },
    create: { projectId: project.id, agentId: agent.id },
    update: {},
  });
  const conversation = await findOrCreateConversation(prisma, {
    projectId: project.id,
    kind: 'human',
    agentIds: [agent.id],
    includesOwner: true,
    title: 'Conductor',
  });
  return { project, agent, conversation };
}

async function projectBySlug(prisma: PrismaClient, slug: string) {
  const project = await prisma.project.findFirst({ where: { slug, isSystem: false } });
  if (project) return project;
  const slugs = (await prisma.project.findMany({ where: { isSystem: false }, select: { slug: true } })).map((p) => p.slug);
  throw new ConductorToolError('not_found', `unknown project "${slug}"; projects: ${slugs.join(', ') || 'none'}`);
}

const team = async (prisma: PrismaClient, projectId: string) =>
  (await projectAgents(prisma, projectId)).map((a) => ({ slug: a.slug, name: a.name, role: a.role }));

const missionLine = (m: { id: string; title: string; status: string; summary: string | null; createdAt: Date }) => ({
  id: m.id,
  title: m.title,
  status: m.status,
  createdAt: m.createdAt,
  summary: m.summary?.slice(0, 600) ?? null,
});

/** The Conductor's own tools: project records only, never a project's files. */
export async function runConductorTool(
  prisma: PrismaClient,
  hub: EventHub,
  run: TaskRun,
  name: string,
  args: Record<string, any>,
): Promise<unknown> {
  switch (name) {
    case 'list_projects': {
      const projects = await prisma.project.findMany({ where: { isSystem: false }, orderBy: { createdAt: 'asc' } });
      return {
        projects: await Promise.all(
          projects.map(async (p) => ({
            slug: p.slug,
            name: p.name,
            defaultBranch: p.defaultBranch,
            team: (await team(prisma, p.id)).map((a) => a.slug),
            liveMissions: await prisma.mission.count({ where: { projectId: p.id, status: { in: [...LIVE_MISSION] } } }),
          })),
        ),
      };
    }
    case 'get_project': {
      const p = await projectBySlug(prisma, args.project);
      const missions = await prisma.mission.findMany({ where: { projectId: p.id }, orderBy: { createdAt: 'desc' }, take: 10 });
      const decisions = await projectDecisions(prisma, { projectId: p.id, limit: 20 });
      return {
        slug: p.slug,
        name: p.name,
        defaultBranch: p.defaultBranch,
        team: await team(prisma, p.id),
        missions: missions.map(missionLine),
        decisions: decisions.map((d) => ({ id: d.id, title: d.title, content: d.content.slice(0, 600) })),
      };
    }
    case 'search_project_memory': {
      const p = await projectBySlug(prisma, args.project);
      const entries = await searchMemory(prisma, { projectId: p.id, q: args.query, status: 'verified', limit: args.limit });
      return { entries: entries.map((e) => ({ id: e.id, type: e.type, title: e.title, content: e.content.slice(0, 1200) })) };
    }
    case 'create_mission': {
      const p = await projectBySlug(prisma, args.project);
      const mission = await createMission(prisma, hub, {
        projectId: p.id,
        request: args.request,
        title: args.title,
        budgetUsd: args.budgetUsd,
        conductorConversationId: run.conversationId ?? undefined,
      });
      await audit(prisma, {
        action: 'mission.created_by_conductor',
        targetType: 'mission',
        targetId: mission.id,
        detail: { project: p.slug, runId: run.id },
      });
      return { missionId: mission.id, project: p.slug, title: mission.title, status: mission.status, budgetUsd: mission.budgetUsd };
    }
    case 'list_missions': {
      const p = args.project ? await projectBySlug(prisma, args.project) : null;
      const missions = await prisma.mission.findMany({
        where: p ? { projectId: p.id } : { project: { isSystem: false } },
        orderBy: { createdAt: 'desc' },
        take: args.limit,
        include: { project: { select: { slug: true } }, approvals: { where: { status: 'pending' }, select: { type: true } } },
      });
      return {
        missions: missions.map((m) => ({
          ...missionLine(m),
          project: m.project.slug,
          pendingApprovals: m.approvals.map((a) => a.type),
        })),
      };
    }
    case 'get_mission': {
      const m = await prisma.mission.findFirst({
        where: { id: args.missionId, project: { isSystem: false } },
        include: {
          project: { select: { slug: true } },
          tasks: { orderBy: { createdAt: 'asc' }, include: { agent: { select: { slug: true } } } },
          approvals: { where: { status: 'pending' }, select: { type: true, reason: true } },
        },
      });
      if (!m) throw new ConductorToolError('not_found', 'mission not found');
      const plan = m.plan as { summary?: string } | null;
      return {
        ...missionLine(m),
        project: m.project.slug,
        request: m.request,
        summary: m.summary,
        planSummary: plan?.summary ?? null,
        planErrors: m.planErrors,
        pendingApprovals: m.approvals,
        tasks: m.tasks.map((t) => ({ key: t.key, title: t.title, kind: t.kind, status: t.status, agent: t.agent.slug, reviewNote: t.reviewNote })),
      };
    }
  }
  throw new ConductorToolError('unknown_tool', `unknown tool: ${name}`);
}
