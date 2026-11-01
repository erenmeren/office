import type { FastifyInstance } from 'fastify';
import type { AgentVersion } from '@office/db';
import { z } from 'zod';
import { AgentConfigInputSchema } from '@office/shared';
import { HttpError } from '../lib/errors.js';
import { createAgentVersion, versionView } from '../services/agent-service.js';

const CreateAgent = z.object({
  name: z.string().min(1),
  slug: z.string().min(1),
  role: z.string().min(1),
  description: z.string().optional(),
  config: AgentConfigInputSchema,
});
const UpdateAgent = z.object({
  name: z.string().min(1).optional(),
  role: z.string().min(1).optional(),
  description: z.string().optional(),
  isActive: z.boolean().optional(),
  config: AgentConfigInputSchema.optional(),
});

export async function agentRoutes(app: FastifyInstance) {
  const withCurrent = async <A extends { currentVersionId: string | null; versions?: AgentVersion[] }>(agent: A) => {
    const current = agent.currentVersionId
      ? await app.prisma.agentVersion.findUnique({ where: { id: agent.currentVersionId } })
      : null;
    return {
      ...agent,
      currentVersion: current && (await versionView(app.prisma, current)),
      ...(agent.versions && { versions: await Promise.all(agent.versions.map((v) => versionView(app.prisma, v))) }),
    };
  };

  app.get('/agents', async () => {
    const agents = await app.prisma.agent.findMany({ where: { isSystem: false }, orderBy: { createdAt: 'asc' } });
    return Promise.all(agents.map(withCurrent));
  });

  app.post('/agents', async (req, reply) => {
    const { config, ...data } = CreateAgent.parse(req.body);
    if (await app.prisma.agent.findUnique({ where: { slug: data.slug } })) {
      throw new HttpError(409, 'conflict');
    }
    const agent = await app.prisma.$transaction(async (tx) => {
      const created = await tx.agent.create({ data });
      const v = await createAgentVersion(tx, created.id, 1, config);
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

  app.get('/agents/:id/versions/:version', async (req) => {
    const { id, version } = req.params as { id: string; version: string };
    const n = Number(version);
    const v = Number.isInteger(n)
      ? await app.prisma.agentVersion.findUnique({ where: { agentId_version: { agentId: id, version: n } } })
      : null;
    if (!v) throw new HttpError(404, 'not_found');
    return versionView(app.prisma, v);
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
        const v = await createAgentVersion(tx, id, (last._max.version ?? 0) + 1, config);
        currentVersionId = v.id;
      }
      return tx.agent.update({ where: { id }, data: { ...data, currentVersionId } });
    });
    return withCurrent(agent);
  });
}
