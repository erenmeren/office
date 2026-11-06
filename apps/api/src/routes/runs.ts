import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from '../config.js';
import { HttpError } from '../lib/errors.js';
import { cancelRun, interruptRun, messageSubagent, pauseRun, resumePausedRun } from '../services/run-service.js';
import { listEvents } from '../services/event-store.js';

export async function runRoutes(app: FastifyInstance, opts: { config: Config }) {
  app.get('/runs/:id', async (req) => {
    const { id } = req.params as { id: string };
    const run = await app.prisma.taskRun.findUnique({ where: { id }, include: { session: true } });
    if (!run) throw new HttpError(404, 'not_found');
    // lost runs report when (finishedAt) and which run retried them: the next run of the same task
    const retry = run.status === 'lost' && run.taskId
      ? await app.prisma.taskRun.findFirst({
          where: { taskId: run.taskId, kind: 'task', createdAt: { gt: run.createdAt } }, orderBy: { createdAt: 'asc' }, select: { id: true },
        })
      : null;
    return { ...run, retriedByRunId: retry?.id ?? null };
  });

  app.post('/runs/:id/cancel', async (req) => {
    const { id } = req.params as { id: string };
    const { task } = z.object({ task: z.enum(['true', 'false']).optional() }).parse(req.query);
    return cancelRun(app.prisma, app.hub, app.gateway, id, req.user!.id, task === 'true', req.log);
  });

  app.post('/runs/:id/interrupt', async (req) => {
    const { id } = req.params as { id: string };
    const { body } = z.object({ body: z.string().trim().min(1).max(20_000) }).parse(req.body);
    return interruptRun(app.prisma, app.hub, opts.config, app.gateway, id, req.user!.id, body);
  });

  app.post('/runs/:id/pause', async (req) => {
    const { id } = req.params as { id: string };
    return pauseRun(app.prisma, app.gateway, id, req.user!.id);
  });

  app.post('/runs/:id/resume', async (req) => {
    const { id } = req.params as { id: string };
    const { body } = z.object({ body: z.string().trim().min(1).max(20_000).default('Continue where you stopped.') }).parse(req.body ?? {});
    return resumePausedRun(app.prisma, app.hub, opts.config, id, req.user!.id, body);
  });

  app.post('/runs/:id/subagents/:toolUseId/messages', async (req) => {
    const { id, toolUseId } = req.params as { id: string; toolUseId: string };
    const { body } = z.object({ body: z.string().trim().min(1).max(20_000) }).parse(req.body);
    return messageSubagent(app.prisma, app.hub, opts.config, id, toolUseId, req.user!.id, body);
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
