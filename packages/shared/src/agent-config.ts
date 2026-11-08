import { z } from 'zod';
import { SkillModeSchema } from './skill.js';
import { SubagentDefinitionSchema } from './subagent.js';

/** Claude Code built-in tools an agent version may be granted; anything not granted is disallowed in the session. */
export const BUILTIN_TOOLS = [
  'Bash',
  'Edit',
  'Write',
  'MultiEdit',
  'NotebookEdit',
  'WebFetch',
  'WebSearch',
  'Agent',
  'Task',
  'KillShell',
  'TodoWrite',
  'Skill',
  'ListMcpResourcesTool',
  'ReadMcpResourceTool',
  'ReadMcpResourceDirTool',
] as const;
/** Always available to a session; never disallowed (except on Conductor runs, which get no built-in tool). */
export const ALWAYS_ON_TOOLS = ['Read', 'Glob', 'Grep'] as const;

/** The hidden system agent the owner talks to above all projects. */
export const CONDUCTOR_SLUG = 'conductor';

/** The agent runtime a run executes on. */
export const RuntimeSchema = z.enum(['claude', 'codex']);
export type Runtime = z.infer<typeof RuntimeSchema>;

/** A budget of 0 is "no cap". The lowest positive cap wins; with none, 0. */
export const minBudget = (...caps: Array<number | undefined>): number =>
  caps.reduce<number>((acc, c) => (c === undefined || c <= 0 ? acc : acc <= 0 ? c : Math.min(acc, c)), 0);

export const AgentConfigSchema = z.object({
  systemPrompt: z.string(),
  model: z.string(),
  runtime: RuntimeSchema.default('claude'),
  effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
  allowedTools: z.array(z.string()),
  maxTurns: z.number().int().positive().default(50),
  maxBudgetUsd: z.number().nonnegative().default(0),
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
