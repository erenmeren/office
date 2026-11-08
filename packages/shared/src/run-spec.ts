import { z } from 'zod';
import { CheckStatusSchema, IntegrationStatusSchema, RunKindSchema, TaskKindSchema } from './enums.js';
import { ApprovalPolicySchema } from './policy.js';
import { EffortSchema, RuntimeSchema } from './agent-config.js';
import { RunSkillSchema } from './skill.js';
import { SubagentDefinitionSchema } from './subagent.js';

export const RunSpecSchema = z.object({
  runId: z.string(),
  sessionId: z.string(),
  agentId: z.string(),
  projectId: z.string(),
  cwd: z.string(),
  prompt: z.string(),
  systemPrompt: z.string(),
  model: z.string(),
  runtime: RuntimeSchema.default('claude'),
  effort: EffortSchema.optional(),
  allowedTools: z.array(z.string()),
  maxTurns: z.number().int(),
  maxBudgetUsd: z.number(),
  maxConcurrentSubagents: z.number().int().default(4),
  maxSubagentDepth: z.number().int().default(1),
  resumeSdkSessionId: z.string().optional(),
  kind: RunKindSchema.default('task'),
  startSeq: z.number().int().nonnegative().default(0),
  // office tool names this run may call; the worker serves exactly these
  tools: z.array(z.string()).default([]),
  // Conductor runs: not even Read, Glob and Grep (it never reads a project's files)
  noBuiltinTools: z.boolean().default(false),
  skills: z.array(RunSkillSchema).default([]),
  subagents: z.array(SubagentDefinitionSchema).default([]),
  // worker-filled: directory passed to additionalDirectories; never set by the API
  skillsDir: z.string().optional(),
  // worker-filled for runs in a worktree: the repository's git dir, which git must still write (objects, refs, index)
  gitDir: z.string().optional(),
  // present for code and review task runs of a mission; the worker creates the worktree and sets cwd itself
  git: z
    .object({
      repoPath: z.string().optional(),
      remote: z.object({ path: z.string().regex(/^\/git\/[0-9a-f-]{36}$/) }).optional(),
      defaultBranch: z.string(),
      missionBranch: z.string(),
      taskSlug: z.string(),
      committerName: z.string(),
      committerEmail: z.string(),
      agentName: z.string(),
    })
    .refine((g) => (g.repoPath === undefined) !== (g.remote === undefined), {
      message: 'git needs exactly one of repoPath or remote',
    })
    .optional(),
  // plan, review and analysis runs: worktree created, no commit expected
  readOnlyCheckout: z.boolean().default(false),
  setupCommand: z.string().optional(),
  checkCommand: z.string().optional(),
  checkTimeoutSeconds: z.number().int().positive().default(900),
  env: z.object({ file: z.string(), vars: z.array(z.object({ name: z.string(), value: z.string() })) }).optional(),
  approvalPolicy: ApprovalPolicySchema.optional(),
  approvalTimeoutMinutes: z.number().int().positive().default(30),
  networkAccess: z.enum(['open', 'allowlist']).default('open'),
  networkAllowedDomains: z.array(z.string()).default([]),
  outputFormat: z.object({ type: z.literal('json_schema'), schema: z.record(z.string(), z.unknown()) }).optional(),
  taskKind: TaskKindSchema.optional(),
});
export type RunSpec = z.infer<typeof RunSpecSchema>;

export const RunResultSchema = z
  .object({
  status: z.enum(['succeeded', 'failed', 'cancelled', 'suspended']),
  resultText: z.string().optional(),
  error: z.string().optional(),
  sdkSessionId: z.string().optional(),
  usage: z.object({
    inputTokens: z.number(),
    outputTokens: z.number(),
    costUsd: z.number(),
    numTurns: z.number(),
    durationMs: z.number(),
  }),
  structuredOutput: z.unknown().optional(),
  git: z
    .object({
      branch: z.string(),
      baseCommit: z.string(),
      headCommit: z.string(),
      commits: z.array(z.object({ sha: z.string(), subject: z.string() })),
      diffStat: z.string(),
      filesChanged: z.number().int(),
      integration: IntegrationStatusSchema,
      /** Why a remote fast-forward was rejected (git's stderr), when it was. */
      integrationReason: z.string().optional(),
      worktreePath: z.string().optional(),
    })
    .optional(),
  check: z
    .object({
      command: z.string(),
      status: CheckStatusSchema,
      exitCode: z.number().int().nullable(),
      durationMs: z.number().int(),
      output: z.string(), // capped at 200 000 chars by the worker
    })
    .optional(),
  })
  .superRefine((r, ctx) => {
    if (r.status === 'suspended' && !r.sdkSessionId) {
      ctx.addIssue({ code: 'custom', path: ['sdkSessionId'], message: 'required when suspended' });
    }
  });
export type RunResult = z.infer<typeof RunResultSchema>;
