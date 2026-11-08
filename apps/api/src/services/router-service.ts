import type { PrismaClient } from '@office/db';
import { AgentConfigSchema, type RoutingRule, type Runtime, type TaskKind } from '@office/shared';

/** Where a task run executes and why; stored on the run (`TaskRun.routing`). */
export interface Route {
  runtime: Runtime;
  model: string;
  reason: string;
}

/** The agent's own runtime and model, from its current version. */
export async function agentDefault(prisma: PrismaClient, agent: { currentVersionId: string | null }): Promise<Omit<Route, 'reason'>> {
  const v = agent.currentVersionId ? await prisma.agentVersion.findUnique({ where: { id: agent.currentVersionId } }) : null;
  const cfg = AgentConfigSchema.safeParse(v?.config);
  return cfg.success ? { runtime: cfg.data.runtime, model: cfg.data.model } : { runtime: 'claude', model: 'sonnet' };
}

/**
 * The first project rule matching the task's kind and priority picks the runtime and model; no match keeps the agent's.
 * A rule without a model keeps the agent's model on the agent's runtime, else the runtime's default (Claude: sonnet,
 * Codex: the CLI's own default, ``).
 */
export function routeTask(rules: RoutingRule[], task: { kind: TaskKind; priority: number }, own: Omit<Route, 'reason'>): Route {
  const i = rules.findIndex((r) => (r.taskKind === undefined || r.taskKind === task.kind) && (r.minPriority === undefined || task.priority >= r.minPriority));
  if (i < 0) return { ...own, reason: "agent's own runtime and model" };
  const rule = rules[i]!;
  const model = rule.model ?? (rule.runtime === own.runtime ? own.model : rule.runtime === 'claude' ? 'sonnet' : '');
  const when = [rule.taskKind && `kind ${rule.taskKind}`, rule.minPriority !== undefined && `priority >= ${rule.minPriority}`].filter(Boolean).join(', ');
  return { runtime: rule.runtime, model, reason: `routing rule ${i + 1}${when ? ` (${when})` : ' (every task)'}` };
}
