import type { Prisma, PrismaClient } from '@office/db';

export const audit = (
  db: PrismaClient | Prisma.TransactionClient,
  e: { userId?: string; action: string; targetType: string; targetId: string; detail?: Prisma.InputJsonValue },
) => db.auditLog.create({ data: e });
