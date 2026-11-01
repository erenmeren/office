import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HttpError } from '../lib/errors.js';
import { cancelRun } from '../services/run-service.js';
import { listEvents } from '../services/event-store.js';

export async function runRoutes(app: FastifyInstance) {
  app.get('/runs/:id', async (req) => {
    const { id } = req.params as { id: string };
    const run = await app.prisma.taskRun.findUnique({ where: { id }, include: { session: true } });
    if (!run) throw new HttpError(404, 'not_found');
    // lost runs report when (finishedAt) and which run retried them: the next run of the same task
    const retry = run.status === 'lost' && run.taskId
      ? await app.prisma.taskRun.findFirst({
          where: { taskId: run.taskId, createdAt: { gt: run.createdAt } }, orderBy: { createdAt: 'asc' }, select: { id: true },
        })
      : null;
    return { ...run, retriedByRunId: retry?.id ?? null };
  });

  app.post('/runs/:id/cancel', async (req) => {
    const { id } = req.params as { id: string };
    const { task } = z.object({ task: z.enum(['true', 'false']).optional() }).parse(req.query);
    return cancelRun(app.prisma, app.hub, app.gateway, id, req.user!.id, task === 'true');
  });

  app.get('/runs/:id/events', async (req) => {
    const { id } = req.params as { id: string };
    const { afterSeq } = z.object({ afterSeq: z.coerce.number().int().nonnegative().default(0) }).parse(req.query);
    const session = await app.prisma.agentSession.findUnique({ where: { runId: id } });
    if (!session) throw new HttpError(404, 'not_found');
    return listEvents(app.prisma, session.id, afterSeq);
  });

  app.get('/runs/:id/subagents', async (req) => {
    const { id } = req.params as { id: string };
    const session = await app.prisma.agentSession.findUnique({ where: { runId: id } });
    if (!session) throw new HttpError(404, 'not_found');
    return app.prisma.subagentRun.findMany({ where: { sessionId: session.id }, orderBy: { startedAt: 'asc' } });
  });
}
