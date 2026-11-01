import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HttpError } from '../lib/errors.js';
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
    const online = new Map(app.gateway.onlineWorkers().map((w) => [w.workerId, w.activeRuns]));
    const workers = await app.prisma.worker.findMany({ select: PUBLIC, orderBy: { createdAt: 'asc' } });
    return workers.map((w) => ({ ...w, online: online.has(w.id), activeRuns: online.get(w.id) ?? 0 }));
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

  app.delete('/workers/:id', async (req) => {
    const { id } = req.params as { id: string };
    if (!(await app.prisma.worker.findUnique({ where: { id } }))) throw new HttpError(404, 'not_found');
    const worker = await app.prisma.worker.update({ where: { id }, data: { status: 'revoked' }, select: PUBLIC });
    app.gateway.disconnect(id);
    return worker;
  });
}
