import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

const Query = z.object({
  action: z.string().optional(),
  targetType: z.string().optional(),
  targetId: z.string().optional(),
  since: z.iso.datetime().optional(),
  /** cursor: createdAt (and id, the tiebreak for rows sharing it) of the last row of the previous page */
  before: z.iso.datetime().optional(),
  beforeId: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(50),
});

export async function auditRoutes(app: FastifyInstance) {
  app.get('/audit', async (req) => {
    const { limit, since, before, beforeId, ...where } = Query.parse(req.query);
    const at = before ? new Date(before) : undefined;
    return app.prisma.auditLog.findMany({
      where: {
        ...where,
        ...(since && { createdAt: { gte: new Date(since) } }),
        ...(at && { OR: [{ createdAt: { lt: at } }, ...(beforeId ? [{ createdAt: at, id: { lt: beforeId } }] : [])] }),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit,
    });
  });
}
