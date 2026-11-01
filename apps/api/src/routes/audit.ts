import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

const Query = z.object({
  targetType: z.string().optional(),
  targetId: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(50),
});

export async function auditRoutes(app: FastifyInstance) {
  app.get('/audit', async (req) => {
    const { limit, ...where } = Query.parse(req.query);
    return app.prisma.auditLog.findMany({ where, orderBy: { createdAt: 'desc' }, take: limit });
  });
}
