import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { PrismaClient, TaskRun } from '@office/db';
import { CONDUCTOR_SLUG, ProjectSettingsSchema } from '@office/shared';
import type { Config } from '../config.js';
import { initRepository } from '../routes/projects.js';
import { audit } from './audit-service.js';
import type { EventHub, Outbox } from './event-hub.js';
import { findOrCreateConversation, queueMessageCreated, toMessageView } from './message-service.js';
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

/** A slug from a project's name: ASCII letters and digits with dashes between. The Turkish dotless ı has no Unicode decomposition, so it is mapped by hand. */
const slugOf = (name: string) =>
  name
    .replace(/ı/g, 'i')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, 40)
    .replace(/^-+|-+$/g, '');

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
  config: Config,
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
    case 'create_project': {
      const base = slugOf(args.name);
      if (!base) throw new ConductorToolError('invalid_name', 'the name needs at least one letter or digit');
      const pathOf = (slug: string) => resolve(config.projectsDir, slug);
      // the first slug neither a project nor a folder carries yet
      let slug = base;
      for (let n = 2; (await prisma.project.findUnique({ where: { slug } })) || existsSync(pathOf(slug)); n++) slug = `${base}-${n}`;
      await initRepository(pathOf(slug), 'main', args.name);
      // the owner looks for the result in this folder, not on a branch: finished work is merged into it
      const project = await prisma.project.create({ data: { name: args.name, slug, repoPath: pathOf(slug), settings: { integrateWhenDone: true } } });
      await audit(prisma, { action: 'project.created_by_conductor', targetType: 'project', targetId: project.id, detail: { slug, runId: run.id } });
      return { project: slug, name: project.name, folder: project.repoPath, team: (await team(prisma, project.id)).map((a) => a.slug) };
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
      // the title of the older mission it starts after, when the project takes one at a time
      const waitsFor = (await missionAhead(prisma, mission, p.settings))?.title ?? null;
      return { missionId: mission.id, project: p.slug, title: mission.title, status: mission.status, budgetUsd: mission.budgetUsd, waitsFor };
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
          project: { select: { slug: true, repoPath: true } },
          tasks: { orderBy: { createdAt: 'asc' }, include: { agent: { select: { slug: true } } } },
          approvals: { where: { status: 'pending' }, select: { type: true, reason: true } },
        },
      });
      if (!m) throw new ConductorToolError('not_found', 'mission not found');
      const plan = m.plan as { summary?: string } | null;
      return {
        ...missionLine(m),
        project: m.project.slug,
        folder: m.project.repoPath,
        branch: m.branch,
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

const run = promisify(execFile);

/**
 * Merges a finished mission's branch into the default branch checked out in the project's own folder,
 * so the owner finds the result there. Touches nothing unless that is plainly safe: the folder on its default
 * branch, no uncommitted change to a tracked file, and a merge without conflicts.
 */
export async function integrateIntoFolder(
  project: { repoPath: string; defaultBranch: string },
  branch: string,
  who: { committerName: string; committerEmail: string },
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const git = (...args: string[]) => run('git', args, { cwd: project.repoPath, timeout: 30_000 }).then((r) => r.stdout.trim());
  try {
    if ((await git('symbolic-ref', '--short', 'HEAD')) !== project.defaultBranch) return { ok: false, reason: `the folder is not on ${project.defaultBranch}` };
    if (await git('status', '--porcelain', '--untracked-files=no')) return { ok: false, reason: 'the folder has changes of its own that are not committed' };
  } catch {
    return { ok: false, reason: 'the folder could not be read' };
  }
  try {
    await git('-c', `user.name=${who.committerName}`, '-c', `user.email=${who.committerEmail}`, 'merge', '--no-edit', branch);
    return { ok: true };
  } catch {
    // a conflict leaves a half-made merge behind
    await git('merge', '--abort').catch(() => undefined);
    return { ok: false, reason: 'it does not merge cleanly with what the folder holds' };
  }
}

const SETTLED = ['done', 'failed', 'plan_failed'] as const;
const ANNOUNCE_WINDOW_MS = 15 * 60_000;

/**
 * Follows up the missions the Conductor opened once they are settled: merges the work into the project's folder when
 * the project asks for it (`integrateWhenDone`), then leaves the Conductor one note in its conversation. The note is
 * mail, so the scheduler wakes the Conductor, which tells the owner in its own words. Only missions settled in the
 * last 15 minutes are announced: nothing from before this existed, and nothing from before a long stop.
 */
export async function announceSettledMissions(prisma: PrismaClient, hub: EventHub, log: { warn: (o: object, msg: string) => void }): Promise<void> {
  const missions = await prisma.mission.findMany({
    where: { conductorConversationId: { not: null }, status: { in: [...SETTLED] }, updatedAt: { gt: new Date(Date.now() - ANNOUNCE_WINDOW_MS) } },
    include: { project: true },
    orderBy: { updatedAt: 'asc' },
  });
  if (missions.length === 0) return;
  const conductor = await prisma.agent.findUnique({ where: { slug: CONDUCTOR_SLUG } });
  if (!conductor) return;
  for (const m of missions) {
    const idempotencyKey = `mission-settled:${m.id}:${m.status}`;
    try {
      if (await prisma.message.findUnique({ where: { idempotencyKey } })) continue;
      const conversation = await prisma.conversation.findUnique({ where: { id: m.conductorConversationId! } });
      if (!conversation) continue;
      let where = '';
      if (m.status === 'done' && m.branch) {
        const settings = ProjectSettingsSchema.parse(m.project.settings ?? {});
        const merged = settings.integrateWhenDone ? await integrateIntoFolder(m.project, m.branch, settings) : null;
        if (merged) await audit(prisma, { action: merged.ok ? 'mission.integrated' : 'mission.not_integrated', targetType: 'mission', targetId: m.id, detail: { branch: m.branch, folder: m.project.repoPath, ...(merged.ok ? {} : { reason: merged.reason }) } });
        where = merged?.ok
          ? ` The files are in the folder ${m.project.repoPath}.`
          : ` The work is on branch ${m.branch} of the folder ${m.project.repoPath}${merged ? `; it was not put into the folder itself because ${merged.reason}` : ''}.`;
      }
      const message = await prisma.message.create({
        data: {
          conversationId: conversation.id,
          projectId: conversation.projectId,
          // a wake type: the Conductor gets a chat run for it
          type: 'escalation',
          body: `Office: "${m.title}" (mission ${m.id}, project ${m.project.slug}) is ${m.status}.${where} Read it with get_mission and tell the owner.`,
          idempotencyKey,
          deliveries: { create: [{ recipientAgentId: conductor.id }] },
        },
        include: { deliveries: true },
      });
      const outbox: Outbox = [];
      queueMessageCreated(outbox, toMessageView(message));
      hub.publishAll(outbox);
    } catch (err) {
      log.warn({ err, missionId: m.id }, 'announcing a settled mission failed');
    }
  }
}

/** Statuses in which a mission still works on its branch. */
const WORKING = ['planning', 'awaiting_approval', 'approved', 'running', 'review'] as const;

/**
 * The older mission this one stands behind, or null. In a project whose finished work lands in its folder by itself
 * (`integrateWhenDone`) missions run one at a time, so each starts from what the one before left there: two started
 * together both branch from the same folder and do not see each other's files.
 */
export async function missionAhead(prisma: PrismaClient, mission: { id: string; projectId: string; createdAt: Date }, settings: unknown) {
  if (!ProjectSettingsSchema.parse(settings ?? {}).integrateWhenDone) return null;
  const older = { projectId: mission.projectId, createdAt: { lt: mission.createdAt } };
  const select = { id: true, title: true } as const;
  const working = await prisma.mission.findFirst({ where: { ...older, status: { in: [...WORKING] } }, orderBy: { createdAt: 'asc' }, select });
  if (working) return working;
  // done, but its note is not written yet: announceSettledMissions puts its work into the folder first
  const done = await prisma.mission.findMany({
    where: { ...older, status: 'done', conductorConversationId: { not: null }, updatedAt: { gt: new Date(Date.now() - ANNOUNCE_WINDOW_MS) } },
    orderBy: { createdAt: 'asc' },
    select,
  });
  for (const m of done) {
    if (!(await prisma.message.findUnique({ where: { idempotencyKey: `mission-settled:${m.id}:done` }, select: { id: true } }))) return m;
  }
  return null;
}
