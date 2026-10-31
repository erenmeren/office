import { z } from 'zod';

export const AgentConfigSchema = z.object({
  systemPrompt: z.string(),
  model: z.string(),
  effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
  allowedTools: z.array(z.string()),
  maxTurns: z.number().int().positive().default(50),
  maxBudgetUsd: z.number().positive().default(2),
  maxConcurrentSubagents: z.number().int().nonnegative().default(4),
  maxSubagentDepth: z.number().int().nonnegative().default(1),
});
export type AgentConfig = z.infer<typeof AgentConfigSchema>;
