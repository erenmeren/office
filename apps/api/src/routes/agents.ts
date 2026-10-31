import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AgentConfigSchema } from '@office/shared';
import { HttpError } from '../lib/errors.js';

const CreateAgent = z.object({
  name: z.string().min(1),
  slug: z.string().min(1),
  role: z.string().min(1),
  description: z.string().optional(),
  config: AgentConfigSchema,
});
const UpdateAgent = z.object({
  name: z.string().min(1).optional(),
  role: z.string().min(1).optional(),
  description: z.string().optional(),
  isActive: z.boolean().optional(),
  config: AgentConfigSchema.optional(),
});

export async function agentRoutes(app: FastifyInstance) {
  const withCurrent = async <A extends { currentVersionId: string | null }>(agent: A) => ({
    ...agent,
    currentVersion: agent.currentVersionId
      ? await app.prisma.agentVersion.findUnique({ where: { id: agent.currentVersionId } })
      : null,
  });

  app.get('/agents', async () => {
    const agents = await app.prisma.agent.findMany({ orderBy: { createdAt: 'asc' } });
    return Promise.all(agents.map(withCurrent));
  });

  app.post('/agents', async (req, reply) => {
    const { config, ...data } = CreateAgent.parse(req.body);
    if (await app.prisma.agent.findUnique({ where: { slug: data.slug } })) {
      throw new HttpError(409, 'conflict');
    }
    const agent = await app.prisma.$transaction(async (tx) => {
      const created = await tx.agent.create({ data });
      const v = await tx.agentVersion.create({ data: { agentId: created.id, version: 1, config } });
      return tx.agent.update({ where: { id: created.id }, data: { currentVersionId: v.id } });
    });
    return reply.code(201).send(await withCurrent(agent));
  });

  app.get('/agents/:id', async (req) => {
    const { id } = req.params as { id: string };
    const agent = await app.prisma.agent.findUnique({
      where: { id },
      include: { versions: { orderBy: { version: 'asc' } } },
    });
    if (!agent) throw new HttpError(404, 'not_found');
    return withCurrent(agent);
  });

  app.put('/agents/:id', async (req) => {
    const { id } = req.params as { id: string };
    const { config, ...data } = UpdateAgent.parse(req.body);
    const agent = await app.prisma.$transaction(async (tx) => {
      const existing = await tx.agent.findUnique({ where: { id } });
      if (!existing) throw new HttpError(404, 'not_found');
      let currentVersionId = existing.currentVersionId;
      if (config) {
        const last = await tx.agentVersion.aggregate({ where: { agentId: id }, _max: { version: true } });
        const v = await tx.agentVersion.create({
          data: { agentId: id, version: (last._max.version ?? 0) + 1, config },
        });
        currentVersionId = v.id;
      }
      return tx.agent.update({ where: { id }, data: { ...data, currentVersionId } });
    });
    return withCurrent(agent);
  });
}
