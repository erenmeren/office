import type { FastifyInstance, FastifyRequest } from 'fastify';
import { HttpError } from '../lib/errors.js';
import { hashToken } from '../lib/tokens.js';

/** Resolves the worker behind `Authorization: Bearer <credential>`; owner cookies are never accepted. */
export async function authenticateWorkerBearer(app: FastifyInstance, request: FastifyRequest): Promise<{ workerId: string }> {
  const m = /^Bearer (\S+)$/.exec(request.headers.authorization ?? '');
  const worker = m
    ? await app.prisma.worker.findFirst({
        where: { credentialHash: hashToken(m[1]!), status: { not: 'revoked' } },
        select: { id: true },
      })
    : null;
  if (!worker) throw new HttpError(401, 'worker_unauthorized');
  return { workerId: worker.id };
}
