import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HttpError } from '../lib/errors.js';
import { audit } from '../services/audit-service.js';
import { generateToken, hashToken } from '../lib/tokens.js';

// never expose enrollTokenHash / credentialHash
const PUBLIC = {
  id: true,
  createdAt: true,
  name: true,
  status: true,
  capacity: true,
  allowedRoots: true,
  tags: true,
  canClone: true,
  machineId: true,
  lastHeartbeatAt: true,
} as const;

export async function workerRoutes(app: FastifyInstance) {
  app.get('/workers', async () => {
    const online = new Map(app.gateway.onlineWorkers().map((w) => [w.workerId, w]));
    const workers = await app.prisma.worker.findMany({ select: PUBLIC, orderBy: { createdAt: 'asc' } });
    return workers.map((w) => ({ ...w, online: online.has(w.id), activeRuns: online.get(w.id)?.activeRuns ?? 0, runtimes: online.get(w.id)?.runtimes ?? [] }));
  });

  app.post('/workers', async (req, reply) => {
    const { name } = z.object({ name: z.string().min(1) }).parse(req.body);
    const enrollToken = generateToken();
    const worker = await app.prisma.worker.create({
      data: { name, status: 'pending', enrollTokenHash: hashToken(enrollToken) },
    });
    // the token is shown once; only its hash is stored
    return reply.code(201).send({ id: worker.id, enrollToken });
  });

  app.delete('/workers/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { purge } = z.object({ purge: z.enum(['true', 'false']).optional() }).parse(req.query);
    const found = await app.prisma.worker.findUnique({ where: { id } });
    if (!found) throw new HttpError(404, 'not_found');
    if (purge === 'true') {
      // ?purge=true removes the row; its finished runs stay with workerId null (FK SET NULL)
      const live = await app.prisma.taskRun.count({
        where: { workerId: id, status: { in: ['queued', 'running', 'waiting_reply', 'waiting_approval'] } },
      });
      if (live) throw new HttpError(409, 'worker_in_use', 'a run is still live on this worker; cancel it first');
      await app.prisma.worker.delete({ where: { id } });
      await audit(app.prisma, {
        userId: req.user!.id, action: 'worker.deleted', targetType: 'worker', targetId: id, detail: { name: found.name },
      });
      app.gateway.disconnect(id);
      return reply.code(204).send();
    }
    const worker = await app.prisma.worker.update({ where: { id }, data: { status: 'revoked' }, select: PUBLIC });
    await audit(app.prisma, { userId: req.user!.id, action: 'worker.revoked', targetType: 'worker', targetId: id });
    app.gateway.disconnect(id);
    return worker;
  });
}
