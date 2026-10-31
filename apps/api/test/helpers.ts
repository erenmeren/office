import { createPrisma } from '@office/db';
import { buildApp, loadConfig } from '../src/app.js';

export async function makeApp() {
  const config = loadConfig({
    ...process.env,
    DATABASE_URL: process.env.DATABASE_URL_TEST,
    OFFICE_SCHEDULER_INTERVAL_MS: '0',
  });
  const prisma = createPrisma(config.databaseUrl);
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "SubagentRun","SessionEvent","UsageRecord","AgentSession","TaskRun","Task","AgentSubagent","AgentSkill","AgentVersion","Agent","SkillVersion","Skill","Worker","Project","UserSession","User" CASCADE',
  );
  const app = await buildApp(config, { prisma, logger: false });
  await app.ready();
  const login = async (): Promise<string> => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/setup',
      payload: { email: 'owner@example.com', password: 'password123' },
    });
    return `office_session=${res.cookies[0]!.value}`;
  };
  const close = async () => {
    await app.close();
    await prisma.$disconnect();
  };
  return { app, prisma, login, close };
}
