import { PrismaClient } from './generated/prisma/client.js';
import { PrismaPg } from '@prisma/adapter-pg';

export function createPrisma(connectionString: string) {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}
export type { PrismaClient };
export * from './generated/prisma/client.js';
export { seed } from './seed.js';
