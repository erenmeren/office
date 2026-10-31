import { z } from 'zod';
import { SKILL_NAME_RE } from './skill.js';

export const SubagentDefinitionSchema = z.object({
  name: z.string().regex(SKILL_NAME_RE),
  description: z.string().min(1),
  prompt: z.string().min(1),
  tools: z.array(z.string()).optional(),
  model: z.string().optional(),
  skills: z.array(z.string()).default([]),
  maxTurns: z.number().int().positive().optional(),
});
export type SubagentDefinition = z.infer<typeof SubagentDefinitionSchema>;
