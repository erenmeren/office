import { z } from 'zod';
import { ApprovalPolicySchema } from './policy.js';
import { WorkerTagSchema } from './protocol.js';

export const ProjectSettingsSchema = z.object({
  packageManager: z.enum(['npm', 'pnpm', 'yarn', 'bun']).optional(),
  setupCommand: z.string().max(500).optional(),
  checkCommand: z.string().max(500).optional(),
  lintCommand: z.string().max(500).optional(),
  envFile: z.string().default('.env.local'),
  envTemplate: z
    .array(z.object({ name: z.string().regex(/^[A-Z_][A-Z0-9_]*$/), value: z.string().max(500) }))
    .default([]),
  committerName: z.string().default('Office Agent'),
  committerEmail: z.string().email().default('office-agent@example.invalid'),
  approvalPolicy: ApprovalPolicySchema.prefault({}),
  approvalTimeoutMinutes: z.number().int().positive().default(30),
  checkTimeoutSeconds: z.number().int().positive().default(900),
  dailyBudgetUsd: z.number().positive().default(50),
  defaultTaskBudgetUsd: z.number().positive().default(5),
  maxConcurrentRuns: z.number().int().positive().default(2),
  defaultMaxAttempts: z.number().int().positive().default(2),
  requiredWorkerTags: z.array(WorkerTagSchema).default([]),
});
export type ProjectSettings = z.infer<typeof ProjectSettingsSchema>;
