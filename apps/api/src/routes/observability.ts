import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  agentRuns,
  listSessions,
  projectActivity,
  projectCosts,
  projectOverview,
  sessionDetail,
} from '../services/observability-service.js';

const Id = z.object({ id: z.string() });

export async function observabilityRoutes(app: FastifyInstance) {
  app.get('/projects/:id/costs', async (req) => {
    const { id } = Id.parse(req.params);
    const q = z
      .object({ days: z.coerce.number().int().min(1).max(366).default(7), groupBy: z.enum(['day', 'agent', 'mission', 'task']).default('day') })
      .parse(req.query);
    return projectCosts(app.prisma, id, q.days, q.groupBy);
  });

  app.get('/projects/:id/overview', async (req) => projectOverview(app.prisma, Id.parse(req.params).id));

  app.get('/projects/:id/activity', async (req) => {
    const { id } = Id.parse(req.params);
    const q = z
      .object({ limit: z.coerce.number().int().min(1).max(200).default(50), beforeSeqId: z.string().min(1).optional() })
      .parse(req.query);
    return projectActivity(app.prisma, id, q.limit, q.beforeSeqId);
  });

  app.get('/sessions', async (req) => {
    const q = z.object({ projectId: z.string().min(1), status: z.enum(['live', 'all']).default('live') }).parse(req.query);
    return listSessions(app.prisma, q.projectId, q.status);
  });

  app.get('/sessions/:runId', async (req) => sessionDetail(app.prisma, z.object({ runId: z.string() }).parse(req.params).runId));

  app.get('/agents/:id/runs', async (req) => {
    const { limit } = z.object({ limit: z.coerce.number().int().min(1).max(200).default(20) }).parse(req.query);
    return agentRuns(app.prisma, Id.parse(req.params).id, limit);
  });
}
