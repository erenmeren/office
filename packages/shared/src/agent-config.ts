import { z } from 'zod';
import { SkillModeSchema } from './skill.js';
import { SubagentDefinitionSchema } from './subagent.js';

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

export const AgentSkillPinSchema = z.object({
  skillId: z.string(),
  skillVersionId: z.string().optional(),
  mode: SkillModeSchema.default('on_demand'),
});
export type AgentSkillPin = z.infer<typeof AgentSkillPinSchema>;

export const AgentConfigInputSchema = AgentConfigSchema.extend({
  skills: z.array(AgentSkillPinSchema).default([]),
  subagents: z.array(SubagentDefinitionSchema).default([]),
});
export type AgentConfigInput = z.infer<typeof AgentConfigInputSchema>;
