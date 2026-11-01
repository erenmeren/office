import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

const Query = z.object({
  action: z.string().optional(),
  targetType: z.string().optional(),
  targetId: z.string().optional(),
  since: z.iso.datetime().optional(),
  /** cursor: createdAt of the last row of the previous page */
  before: z.iso.datetime().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(50),
});

export async function auditRoutes(app: FastifyInstance) {
  app.get('/audit', async (req) => {
    const { limit, since, before, ...where } = Query.parse(req.query);
    return app.prisma.auditLog.findMany({
      where: { ...where, createdAt: { ...(since && { gte: new Date(since) }), ...(before && { lt: new Date(before) }) } },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  });
}
