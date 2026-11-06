import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { MessageLimitsSchema, type MessageLimits } from '@office/shared';
import { machineId } from '@office/runtime';

const EnvSchema = z.object({
  DATABASE_URL: z.string().min(1),
  API_PORT: z.coerce.number().int().positive().default(4000),
  API_HOST: z.string().min(1).default('127.0.0.1'),
  COOKIE_SECRET: z.string().min(32),
  WEB_ORIGIN: z.string().min(1),
  OFFICE_DATA_DIR: z.string().min(1),
  OFFICE_EMBEDDINGS: z.enum(['on', 'off']).default('on'),
  OFFICE_LEASE_SECONDS: z.coerce.number().int().positive().default(60),
  OFFICE_HEARTBEAT_SECONDS: z.coerce.number().int().positive().default(10),
  OFFICE_SCHEDULER_INTERVAL_MS: z.coerce.number().int().nonnegative().default(2000),
  OFFICE_SKILL_IMPORT_ROOTS: z.string().optional(),
  OFFICE_MSG_PER_SESSION: z.coerce.number().int().positive().optional(),
  OFFICE_MSG_PER_TASK: z.coerce.number().int().positive().optional(),
  OFFICE_ESCALATION_DEPTH: z.coerce.number().int().positive().optional(),
  OFFICE_HANDOFF_CHAIN: z.coerce.number().int().positive().optional(),
  OFFICE_MACHINE_ID: z.string().min(1).max(128).optional(),
  OFFICE_GIT_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(600),
  OFFICE_REPLY_TIMEOUT_MINUTES: z.coerce.number().int().nonnegative().default(60),
  OFFICE_CONTEXT_PACK_MAX_CHARS: z.coerce.number().int().positive().default(12000),
  OFFICE_TRUST_UNIDENTIFIED_WORKERS: z.enum(['true', 'false']).default('false'),
});

export interface Config {
  databaseUrl: string;
  port: number;
  host: string;
  cookieSecret: string;
  webOrigin: string;
  dataDir: string;
  embeddings: boolean;
  artifactsDir: string;
  leaseSeconds: number;
  heartbeatSeconds: number;
  schedulerIntervalMs: number;
  cookieSecure: boolean;
  skillImportRoots: string[];
  messageLimits: MessageLimits;
  replyTimeoutMinutes: number;
  contextPackMaxChars: number;
  gitHooksDir: string;
  /** This host's identity; only a worker reporting the same id may use the repo checkout directly. */
  machineId: string;
  gitTimeoutSeconds: number;
  /** Treat workers that send no machineId (pre-Phase 5) as on this machine when their roots cover the repo. */
  trustUnidentifiedWorkers: boolean;
}

// the package root (the directory holding package.json), from src/ under tsx and from dist/ under node
function packageDir(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(join(dir, 'package.json'))) {
    const up = dirname(dir);
    if (up === dir) throw new Error('package.json not found above ' + fileURLToPath(import.meta.url));
    dir = up;
  }
  return dir;
}

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
    // absolute: repository paths derived from it are stored and handed to workers
    dataDir: resolve(e.OFFICE_DATA_DIR),
    embeddings: e.OFFICE_EMBEDDINGS === 'on',
    artifactsDir: resolve(e.OFFICE_DATA_DIR, 'artifacts'),
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
    gitHooksDir: join(packageDir(), 'git-hooks'),
    machineId: machineId(e.OFFICE_DATA_DIR, undefined, e.OFFICE_MACHINE_ID),
    gitTimeoutSeconds: e.OFFICE_GIT_TIMEOUT_SECONDS,
    trustUnidentifiedWorkers: e.OFFICE_TRUST_UNIDENTIFIED_WORKERS === 'true',
    cookieSecure: env.NODE_ENV === 'production',
    // the owner's own Claude skills (~/.claude/skills, plugin caches) are importable by default
    skillImportRoots: (e.OFFICE_SKILL_IMPORT_ROOTS ? e.OFFICE_SKILL_IMPORT_ROOTS.split(':').filter(Boolean) : [join(homedir(), '.claude')]).map(realOrGiven),
  };
}
