import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  MemoryScopeSchema,
  MemorySourceInputSchema,
  MemoryStatusSchema,
  MemoryTypeSchema,
} from '@office/shared';
import { audit } from '../services/audit-service.js';
import { HttpError } from '../lib/errors.js';
import {
  createEntry,
  deleteEntry,
  getEntry,
  proposedCount,
  rejectEntry,
  searchMemory,
  supersedeEntry,
  verifyEntry,
} from '../services/memory-service.js';

const Project = z.object({ projectId: z.string().min(1) });
const Create = z.object({
  projectId: z.string().min(1),
  type: MemoryTypeSchema,
  scope: MemoryScopeSchema.default('project'),
  title: z.string().min(1).max(200),
  content: z.string().min(1).max(8000),
  sources: z.array(MemorySourceInputSchema).default([]),
});
const Update = z.object({
  title: z.string().min(1).max(200),
  content: z.string().min(1).max(8000),
  type: MemoryTypeSchema.optional(),
  sources: z.array(MemorySourceInputSchema).optional(),
  projectId: z.string().min(1).optional(),
});

export async function memoryRoutes(app: FastifyInstance) {
  const changed = (entryId: string, status: z.infer<typeof MemoryStatusSchema>) =>
    app.hub.publish('global', { type: 'memory.changed', topic: 'global', entryId, status });

  const optProject = (v: unknown) => z.object({ projectId: z.string().min(1).optional() }).parse(v).projectId;

  app.get('/memory', async (req) => {
    const q = z
      .object({
        projectId: z.string().min(1),
        q: z.string().optional(),
        type: MemoryTypeSchema.optional(),
        status: MemoryStatusSchema.optional(),
        agentId: z.string().min(1).optional(),
      })
      .parse(req.query);
    return searchMemory(app.prisma, q);
  });

  app.get('/memory/counts', async (req) => {
    const { projectId } = Project.parse(req.query);
    return { proposed: await proposedCount(app.prisma, projectId) };
  });

  app.post('/memory', async (req, reply) => {
    const data = Create.parse(req.body);
    if (!(await app.prisma.project.findUnique({ where: { id: data.projectId } }))) throw new HttpError(404, 'not_found');
    const e = await createEntry(app.prisma, { ...data, authorType: 'user', status: 'verified' });
    changed(e.id, e.status);
    return reply.code(201).send(e);
  });

  app.get('/memory/:id', async (req) => {
    const { id } = req.params as { id: string };
    return getEntry(app.prisma, id, Project.parse(req.query).projectId);
  });

  app.post('/memory/:id/verify', async (req) => {
    const { id } = req.params as { id: string };
    const e = await verifyEntry(app.prisma, id, optProject(req.query));
    await audit(app.prisma, { userId: req.user!.id, action: 'memory.verified', targetType: 'memory', targetId: id });
    changed(e.id, e.status);
    return e;
  });

  app.post('/memory/:id/reject', async (req) => {
    const { id } = req.params as { id: string };
    const e = await rejectEntry(app.prisma, id, optProject(req.query));
    await audit(app.prisma, { userId: req.user!.id, action: 'memory.rejected', targetType: 'memory', targetId: id });
    changed(e.id, e.status);
    return e;
  });

  app.put('/memory/:id', async (req) => {
    const { id } = req.params as { id: string };
    const { projectId: bodyProject, ...body } = Update.parse(req.body);
    const e = await supersedeEntry(app.prisma, id, bodyProject ?? optProject(req.query), { ...body, actor: 'user' });
    changed(e.id, e.status);
    return e;
  });

  app.delete('/memory/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const e = await deleteEntry(app.prisma, id, optProject(req.query));
    changed(e.id, e.status);
    return reply.code(204).send();
  });
}
