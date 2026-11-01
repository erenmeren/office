import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ProjectSettingsSchema, type ProjectSettings } from '@office/shared';
import { HttpError } from '../lib/errors.js';
import { audit } from '../services/audit-service.js';
import { getSettings, projectAgents, setProjectAgents, updateSettings } from '../services/project-service.js';

const CreateProject = z.object({
  name: z.string().min(1),
  slug: z.string().min(1),
  repoPath: z.string().min(1),
  defaultBranch: z.string().min(1).optional(),
});

export async function projectRoutes(app: FastifyInstance) {
  app.get('/projects', async () => app.prisma.project.findMany({ orderBy: { createdAt: 'asc' } }));

  app.post('/projects', async (req, reply) => {
    const data = CreateProject.parse(req.body);
    if (await app.prisma.project.findUnique({ where: { slug: data.slug } })) {
      throw new HttpError(409, 'conflict');
    }
    return reply.code(201).send(await app.prisma.project.create({ data }));
  });

  app.get('/projects/:id', async (req) => {
    const { id } = req.params as { id: string };
    const project = await app.prisma.project.findUnique({ where: { id } });
    if (!project) throw new HttpError(404, 'not_found');
    return project;
  });

  app.get('/projects/:id/settings', async (req) => getSettings(app.prisma, (req.params as { id: string }).id));

  app.put('/projects/:id/settings', async (req) => {
    const { id } = req.params as { id: string };
    // Zod applies defaults inside .partial(); keep only keys actually sent so they don't overwrite stored values.
    const parsed = ProjectSettingsSchema.partial().parse(req.body) as Record<string, unknown>;
    const patch = Object.fromEntries(Object.entries(parsed).filter(([k]) => k in (req.body as object)));
    const settings = await updateSettings(app.prisma, id, patch as Partial<ProjectSettings>);
    await audit(app.prisma, { userId: req.user!.id, action: 'settings.updated', targetType: 'project', targetId: id, detail: { keys: Object.keys(patch) } });
    return settings;
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
