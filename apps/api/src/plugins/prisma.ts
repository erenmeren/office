import type { FastifyInstance } from 'fastify';
import { createPrisma, type PrismaClient } from '@office/db';

declare module 'fastify' {
  interface FastifyInstance {
    prisma: PrismaClient;
  }
}

export function registerPrisma(app: FastifyInstance, databaseUrl: string, given?: PrismaClient) {
  const prisma = given ?? createPrisma(databaseUrl);
  app.decorate('prisma', prisma);
  if (!given) app.addHook('onClose', async () => prisma.$disconnect());
}
