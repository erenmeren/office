import { z } from 'zod';
import { RunKindSchema } from './enums.js';
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
  effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
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
  skills: z.array(RunSkillSchema).default([]),
  subagents: z.array(SubagentDefinitionSchema).default([]),
  // worker-filled: directory passed to additionalDirectories; never set by the API
  skillsDir: z.string().optional(),
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
  })
  .superRefine((r, ctx) => {
    if (r.status === 'suspended' && !r.sdkSessionId) {
      ctx.addIssue({ code: 'custom', path: ['sdkSessionId'], message: 'required when suspended' });
    }
  });
export type RunResult = z.infer<typeof RunResultSchema>;
