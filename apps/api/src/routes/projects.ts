import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HttpError } from '../lib/errors.js';

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
}
