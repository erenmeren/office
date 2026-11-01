import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ApprovalScopeSchema, ApprovalStatusSchema } from '@office/shared';
import { HttpError } from '../lib/errors.js';
import { decideApproval } from '../services/approval-service.js';
import { toApprovalView } from '../services/mission-service.js';

export async function approvalRoutes(app: FastifyInstance) {
  app.get('/approvals', async (req) => {
    const { projectId, status } = z
      .object({ projectId: z.string().optional(), status: ApprovalStatusSchema.optional() })
      .parse(req.query);
    return app.prisma.approval.findMany({ where: { projectId, status }, orderBy: { createdAt: 'desc' } });
  });

  app.get('/approvals/:id', async (req) => {
    const { id } = req.params as { id: string };
    const approval = await app.prisma.approval.findUnique({ where: { id } });
    if (!approval) throw new HttpError(404, 'not_found');
    return toApprovalView(approval);
  });

  app.post('/approvals/:id/approve', async (req) => {
    const { id } = req.params as { id: string };
    const { scope } = z.object({ scope: ApprovalScopeSchema.default('once') }).parse(req.body ?? {});
    return decideApproval(app.prisma, app.hub, app.gateway, id, { decision: 'allow', scope, userId: req.user!.id });
  });

  const deny = async (req: { params: unknown; body: unknown; user?: { id: string } | null }) => {
    const { id } = req.params as { id: string };
    const { message } = z.object({ message: z.string().max(2000).optional() }).parse(req.body ?? {});
    return decideApproval(app.prisma, app.hub, app.gateway, id, { decision: 'deny', scope: 'once', userId: req.user!.id, message });
  };
  app.post('/approvals/:id/deny', deny);
  // kept for plan approvals
  app.post('/approvals/:id/reject', deny);
}
