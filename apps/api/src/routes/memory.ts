import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  MemoryScopeSchema,
  MemorySourceInputSchema,
  MemoryStatusSchema,
  MemoryTypeSchema,
} from '@office/shared';
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
});

export async function memoryRoutes(app: FastifyInstance) {
  const changed = (entryId: string, status: z.infer<typeof MemoryStatusSchema>) =>
    app.hub.publish('global', { type: 'memory.changed', topic: 'global', entryId, status });

  // The project of an existing entry comes from the row itself (single-owner API).
  const projectOf = async (id: string) => {
    const e = await app.prisma.memoryEntry.findUnique({ where: { id }, select: { projectId: true } });
    if (!e?.projectId) throw new HttpError(404, 'not_found');
    return e.projectId;
  };

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
    const e = await verifyEntry(app.prisma, id, await projectOf(id));
    changed(e.id, e.status);
    return e;
  });

  app.post('/memory/:id/reject', async (req) => {
    const { id } = req.params as { id: string };
    const e = await rejectEntry(app.prisma, id, await projectOf(id));
    changed(e.id, e.status);
    return e;
  });

  app.put('/memory/:id', async (req) => {
    const { id } = req.params as { id: string };
    const e = await supersedeEntry(app.prisma, id, await projectOf(id), { ...Update.parse(req.body), actor: 'user' });
    changed(e.id, e.status);
    return e;
  });

  app.delete('/memory/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const e = await deleteEntry(app.prisma, id, await projectOf(id));
    changed(e.id, e.status);
    return reply.code(204).send();
  });
}
