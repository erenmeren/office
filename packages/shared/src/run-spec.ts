import { z } from 'zod';

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
});
export type RunSpec = z.infer<typeof RunSpecSchema>;

export const RunResultSchema = z.object({
  status: z.enum(['succeeded', 'failed', 'cancelled']),
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
});
export type RunResult = z.infer<typeof RunResultSchema>;
