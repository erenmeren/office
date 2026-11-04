import type { FastifyInstance } from 'fastify';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { ProjectSettingsSchema, type ProjectSettings } from '@office/shared';
import type { Config } from '../config.js';
import { HttpError } from '../lib/errors.js';
import { audit } from '../services/audit-service.js';
import { dailyLimit, spentToday } from '../services/budget-service.js';
import { expireDailyBudgetApprovals } from '../services/budget-service.js';
import { getSettings, projectAgents, setProjectAgents, updateSettings } from '../services/project-service.js';

const CreateProject = z.object({
  name: z.string().min(1),
  slug: z.string().min(1),
  // without repoPath a new repository is created under <OFFICE_DATA_DIR>/repos/<slug> (greenfield project)
  repoPath: z.string().min(1).optional(),
  defaultBranch: z.string().min(1).optional(),
});

const run = promisify(execFile);

/**
 * `git init` plus one empty commit on `branch`, so the worker can create mission branches from it.
 * `inPlace`: the owner's own folder, existing or not (files in it stay untracked); otherwise a new directory is required.
 */
async function initRepository(path: string, branch: string, name: string, inPlace = false): Promise<void> {
  const { committerName, committerEmail } = ProjectSettingsSchema.parse({});
  await mkdir(join(path, '..'), { recursive: true });
  // mkdir without `recursive` refuses an existing directory: never init over somebody's files unless asked
  if (inPlace) await mkdir(path, { recursive: true });
  else await mkdir(path);
  const git = (...args: string[]) => run('git', ['-c', `user.name=${committerName}`, '-c', `user.email=${committerEmail}`, ...args], { cwd: path });
  await git('init', '-q', '-b', branch);
  // a starter CLAUDE.md and .gitignore so the first agent (and the owner's own claude) find the ground rules; existing files are kept
  for (const [file, content] of Object.entries(starterFiles(name, branch))) {
    if (!existsSync(join(path, file))) await writeFile(join(path, file), content);
  }
  await git('add', '-A');
  await git('commit', '-q', '--allow-empty', '-m', 'Initial commit');
}

/** What a fresh project repository starts with. */
export function starterFiles(name: string, branch: string): Record<string, string> {
  return {
    'CLAUDE.md': `# ${name}

Managed by Claude Agent Office. Agents work on \`office/*\` branches in their own worktrees and commit there; the owner integrates into \`${branch}\`.

## About

Describe here what this project is for, who uses it, and how it is run.

## Conventions

- The build and test command lives in Office Settings (\`checkCommand\`); every code run must pass it before it is integrated.
- Small commits with a clear message; no secrets, no build output in git.
- Keep this file current: it is the first thing every agent reads.
`,
    '.gitignore': `node_modules/
dist/
build/
.env
.env.*
!.env.example
`,
  };
}

/** The repository root that holds `path`, or null outside any repository. */
const repoRootOf = (path: string) => run('git', ['rev-parse', '--show-toplevel'], { cwd: path }).then((r) => resolve(r.stdout.trim())).catch(() => null);

export async function projectRoutes(app: FastifyInstance, opts: { config: Config }) {
  app.get('/settings/runtime', async () => ({ leaseSeconds: opts.config.leaseSeconds, heartbeatSeconds: opts.config.heartbeatSeconds }));

  app.get('/projects', async () => app.prisma.project.findMany({ orderBy: { createdAt: 'asc' } }));

  app.post('/projects', async (req, reply) => {
    const data = CreateProject.parse(req.body);
    if (await app.prisma.project.findUnique({ where: { slug: data.slug } })) {
      throw new HttpError(409, 'conflict');
    }
    let repoPath = data.repoPath;
    if (!repoPath) {
      // absolute: the worker's allowedRoots check and git itself must not depend on the API's cwd
      repoPath = resolve(opts.config.dataDir, 'repos', data.slug);
      await initRepository(repoPath, data.defaultBranch ?? 'main', data.name).catch((err: NodeJS.ErrnoException) => {
        if (err.code === 'EEXIST') throw new HttpError(409, 'repo_exists');
        throw err;
      });
    }
    else {
      repoPath = resolve(repoPath);
      const root = existsSync(repoPath) ? await repoRootOf(repoPath) : null;
      if (root && root !== repoPath) {
        // a folder inside somebody's repository would make the whole repository the project's working tree
        throw new HttpError(400, 'not_repo_root', `${repoPath} is inside the repository at ${root}; give that path, or an empty folder for a new repository`);
      }
      if (!root) {
        // the owner's own new folder (or a path that does not exist yet): make it a repository
        await initRepository(repoPath, data.defaultBranch ?? 'main', data.name, true);
      } else if (!data.defaultBranch) {
        // an existing repository: its checked-out branch is the default, not the form's "main" (the repo may use master)
        const head = await run('git', ['symbolic-ref', '--short', 'HEAD'], { cwd: repoPath }).then((r) => r.stdout.trim()).catch(() => '');
        if (head) data.defaultBranch = head;
      }
    }
    return reply.code(201).send(await app.prisma.project.create({ data: { ...data, repoPath } }));
  });

  app.get('/projects/:id', async (req) => {
    const { id } = req.params as { id: string };
    const project = await app.prisma.project.findUnique({ where: { id } });
    if (!project) throw new HttpError(404, 'not_found');
    return project;
  });

  app.put('/projects/:id', async (req) => {
    const { id } = req.params as { id: string };
    const data = z.object({ name: z.string().min(1).optional(), defaultBranch: z.string().min(1).optional() }).parse(req.body);
    if (!(await app.prisma.project.findUnique({ where: { id } }))) throw new HttpError(404, 'not_found');
    const project = await app.prisma.project.update({ where: { id }, data });
    await audit(app.prisma, { userId: req.user!.id, action: 'project.updated', targetType: 'project', targetId: id, detail: data });
    return project;
  });

  // refused while the project has any task, mission or run: their records would lose their project
  app.delete('/projects/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const project = await app.prisma.project.findUnique({ where: { id }, include: { _count: { select: { tasks: true, missions: true, runs: true } } } });
    if (!project) throw new HttpError(404, 'not_found');
    if (project._count.tasks || project._count.missions || project._count.runs) throw new HttpError(409, 'project_in_use');
    await app.prisma.$transaction([
      app.prisma.projectAgent.deleteMany({ where: { projectId: id } }),
      app.prisma.project.delete({ where: { id } }),
    ]);
    await audit(app.prisma, { userId: req.user!.id, action: 'project.deleted', targetType: 'project', targetId: id, detail: { slug: project.slug } });
    return reply.code(204).send();
  });

  app.get('/projects/:id/settings', async (req) => getSettings(app.prisma, (req.params as { id: string }).id));

  app.put('/projects/:id/settings', async (req) => {
    const { id } = req.params as { id: string };
    // Zod applies defaults inside .partial(); keep only keys actually sent so they don't overwrite stored values.
    const parsed = ProjectSettingsSchema.partial().parse(req.body) as Record<string, unknown>;
    const patch = Object.fromEntries(Object.entries(parsed).filter(([k]) => k in (req.body as object)));
    const settings = await updateSettings(app.prisma, id, patch as Partial<ProjectSettings>);
    // a raised daily budget answers the pending daily-budget approvals: the scheduler re-checks the limit on its own
    if ('dailyBudgetUsd' in patch) await expireDailyBudgetApprovals(app.prisma, app.hub, id);
    await audit(app.prisma, { userId: req.user!.id, action: 'settings.updated', targetType: 'project', targetId: id, detail: { keys: Object.keys(patch) } });
    return settings;
  });

  app.get('/projects/:id/budget', async (req) => {
    const { id } = req.params as { id: string };
    // today's limit, including budget_exceeded approvals decided today
    const dailyBudgetUsd = await dailyLimit(app.prisma, await getSettings(app.prisma, id), id);
    return { spentTodayUsd: await spentToday(app.prisma, { projectId: id }), dailyBudgetUsd };
  });

  app.get('/projects/:id/agents', async (req) => {
    const { id } = req.params as { id: string };
    await getSettings(app.prisma, id); // 404 when project is missing
    return projectAgents(app.prisma, id);
  });

  app.put('/projects/:id/agents', async (req) => {
    const { id } = req.params as { id: string };
    const { agentIds } = z.object({ agentIds: z.array(z.string()) }).parse(req.body);
    const agents = await setProjectAgents(app.prisma, id, agentIds);
    await audit(app.prisma, { userId: req.user!.id, action: 'project_agents.updated', targetType: 'project', targetId: id, detail: { agentIds } });
    return agents;
  });
}
