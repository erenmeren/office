import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HttpError } from '../lib/errors.js';
import { listEvents } from '../services/event-store.js';

export async function runRoutes(app: FastifyInstance) {
  app.get('/runs/:id', async (req) => {
    const { id } = req.params as { id: string };
    const run = await app.prisma.taskRun.findUnique({ where: { id }, include: { session: true } });
    if (!run) throw new HttpError(404, 'not_found');
    return run;
  });

  app.get('/runs/:id/events', async (req) => {
    const { id } = req.params as { id: string };
    const { afterSeq } = z.object({ afterSeq: z.coerce.number().int().nonnegative().default(0) }).parse(req.query);
    const session = await app.prisma.agentSession.findUnique({ where: { runId: id } });
    if (!session) throw new HttpError(404, 'not_found');
    return listEvents(app.prisma, session.id, afterSeq);
  });
}
