import { existsSync, realpathSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { resolve } from 'node:path';
import { WorkerTagSchema } from '@office/shared';
import { machineId } from '@office/runtime';

export interface WorkerConfig {
  apiUrl: string;
  home: string;
  enrollToken?: string;
  workspaceRoots: string[];
  runtime: 'claude' | 'fake';
  capacity: number;
  name: string;
  tags: string[];
  canClone: boolean;
  machineId: string;
}

const expandHome = (p: string) => (p === '~' || p.startsWith('~/') ? homedir() + p.slice(1) : p);

export function loadWorkerConfig(env: Record<string, string | undefined> = process.env, etcMachineId?: string): WorkerConfig {
  if (!env.OFFICE_API_URL) throw new Error('Missing environment variable: OFFICE_API_URL');
  const runtime = env.OFFICE_RUNTIME ?? 'claude';
  if (runtime !== 'claude' && runtime !== 'fake') throw new Error(`Invalid OFFICE_RUNTIME: ${runtime}`);
  const capacity = Number(env.OFFICE_WORKER_CAPACITY ?? 2);
  if (!Number.isInteger(capacity) || capacity < 1) throw new Error('Invalid OFFICE_WORKER_CAPACITY');
  const roots = (env.OFFICE_WORKSPACE_ROOTS ?? '').split(':').filter(Boolean);
  const canClone = env.OFFICE_WORKER_CAN_CLONE === 'true';
  if (roots.length === 0 && !canClone) throw new Error('OFFICE_WORKSPACE_ROOTS is empty or missing; set it to a colon-separated list of directories');
  const tags = (env.OFFICE_WORKER_TAGS ?? '').split(',').map((t) => t.trim()).filter(Boolean);
  for (const t of tags) {
    if (!WorkerTagSchema.safeParse(t).success) throw new Error(`Invalid tag in OFFICE_WORKER_TAGS: ${t}`);
  }
  const home = resolve(expandHome(env.OFFICE_WORKER_HOME ?? '~/.office-worker'));
  return {
    apiUrl: env.OFFICE_API_URL,
    home,
    enrollToken: env.OFFICE_ENROLL_TOKEN || undefined,
    workspaceRoots: roots.map((p) => {
      const abs = resolve(expandHome(p));
      if (!existsSync(abs)) throw new Error(`Workspace root does not exist: ${abs} (OFFICE_WORKSPACE_ROOTS)`);
      return realpathSync(abs);
    }),
    runtime,
    capacity,
    name: env.OFFICE_WORKER_NAME || hostname(),
    tags,
    canClone,
    machineId: machineId(home, etcMachineId, env.OFFICE_MACHINE_ID?.trim() || undefined),
  };
}
