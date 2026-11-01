import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { MessageLimitsSchema, type MessageLimits } from '@office/shared';

const EnvSchema = z.object({
  DATABASE_URL: z.string().min(1),
  API_PORT: z.coerce.number().int().positive().default(4000),
  API_HOST: z.string().min(1).default('127.0.0.1'),
  COOKIE_SECRET: z.string().min(32),
  WEB_ORIGIN: z.string().min(1),
  OFFICE_DATA_DIR: z.string().min(1),
  OFFICE_LEASE_SECONDS: z.coerce.number().int().positive().default(60),
  OFFICE_HEARTBEAT_SECONDS: z.coerce.number().int().positive().default(10),
  OFFICE_SCHEDULER_INTERVAL_MS: z.coerce.number().int().nonnegative().default(2000),
  OFFICE_SKILL_IMPORT_ROOTS: z.string().optional(),
  OFFICE_MSG_PER_SESSION: z.coerce.number().int().positive().optional(),
  OFFICE_MSG_PER_TASK: z.coerce.number().int().positive().optional(),
  OFFICE_ESCALATION_DEPTH: z.coerce.number().int().positive().optional(),
  OFFICE_HANDOFF_CHAIN: z.coerce.number().int().positive().optional(),
  OFFICE_REPLY_TIMEOUT_MINUTES: z.coerce.number().int().nonnegative().default(60),
  OFFICE_CONTEXT_PACK_MAX_CHARS: z.coerce.number().int().positive().default(12000),
});

export interface Config {
  databaseUrl: string;
  port: number;
  host: string;
  cookieSecret: string;
  webOrigin: string;
  dataDir: string;
  leaseSeconds: number;
  heartbeatSeconds: number;
  schedulerIntervalMs: number;
  cookieSecure: boolean;
  skillImportRoots: string[];
  messageLimits: MessageLimits;
  replyTimeoutMinutes: number;
  contextPackMaxChars: number;
}

const defaultSkillRoot = resolve(fileURLToPath(new URL('../../../templates/skills', import.meta.url)));

function realOrGiven(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const r = EnvSchema.safeParse(env);
  if (!r.success) {
    const names = [...new Set(r.error.issues.map((i) => String(i.path[0])))].join(', ');
    throw new Error(`Invalid or missing environment variable(s): ${names}`);
  }
  const e = r.data;
  return {
    databaseUrl: e.DATABASE_URL,
    port: e.API_PORT,
    host: e.API_HOST,
    cookieSecret: e.COOKIE_SECRET,
    webOrigin: e.WEB_ORIGIN,
    dataDir: e.OFFICE_DATA_DIR,
    leaseSeconds: e.OFFICE_LEASE_SECONDS,
    heartbeatSeconds: e.OFFICE_HEARTBEAT_SECONDS,
    schedulerIntervalMs: e.OFFICE_SCHEDULER_INTERVAL_MS,
    messageLimits: MessageLimitsSchema.parse({
      perSession: e.OFFICE_MSG_PER_SESSION,
      perTask: e.OFFICE_MSG_PER_TASK,
      escalationDepth: e.OFFICE_ESCALATION_DEPTH,
      handoffChain: e.OFFICE_HANDOFF_CHAIN,
    }),
    replyTimeoutMinutes: e.OFFICE_REPLY_TIMEOUT_MINUTES,
    contextPackMaxChars: e.OFFICE_CONTEXT_PACK_MAX_CHARS,
    cookieSecure: env.NODE_ENV === 'production',
    skillImportRoots: (e.OFFICE_SKILL_IMPORT_ROOTS ? e.OFFICE_SKILL_IMPORT_ROOTS.split(':').filter(Boolean) : [defaultSkillRoot]).map(realOrGiven),
  };
}
