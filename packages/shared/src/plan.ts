import { z } from 'zod';
import { ApprovalTypeSchema, TaskKindSchema } from './enums.js';

export const PlanTaskSchema = z.object({
  key: z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/),
  title: z.string().min(1).max(120),
  description: z.string().min(1).max(4000),
  kind: TaskKindSchema,
  agent: z.string(), // slug
  requirements: z.array(z.string().min(1)).min(1).max(20),
  acceptanceCriteria: z.array(z.string().min(1)).min(1).max(20),
  dependsOn: z.array(z.string()).default([]),
  parallelGroup: z.string().optional(),
  requiredConsultations: z.array(z.object({ agent: z.string(), topic: z.string().min(1) })).default([]),
  approvalPoints: z.array(ApprovalTypeSchema).default([]),
  budgetUsd: z.number().positive().max(50).optional(),
});
export type PlanTask = z.infer<typeof PlanTaskSchema>;

export const PlanSchema = z.object({
  summary: z.string().min(1).max(2000),
  tasks: z.array(PlanTaskSchema).min(1).max(30),
  risks: z.array(z.string()).default([]),
});
export type Plan = z.infer<typeof PlanSchema>;

export const ReviewDecisionSchema = z.object({
  summary: z.string().min(1).max(4000),
  tasks: z.array(
    z.object({
      taskId: z.string(),
      decision: z.enum(['done', 'reopen']),
      note: z.string().max(2000).default(''),
    }),
  ),
});
export type ReviewDecision = z.infer<typeof ReviewDecisionSchema>;

const strArray = { type: 'array', items: { type: 'string' } } as const;
const nonEmptyStrArray = {
  type: 'array',
  minItems: 1,
  maxItems: 20,
  items: { type: 'string', minLength: 1 },
} as const;

// Hand-written twin of PlanSchema for the SDK's structured output; plan.test.ts guards against drift.
export const PLAN_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'tasks', 'risks'],
  properties: {
    summary: { type: 'string', minLength: 1, maxLength: 2000 },
    tasks: {
      type: 'array',
      minItems: 1,
      maxItems: 30,
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'key',
          'title',
          'description',
          'kind',
          'agent',
          'requirements',
          'acceptanceCriteria',
          'dependsOn',
          'requiredConsultations',
          'approvalPoints',
        ],
        properties: {
          key: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{0,31}$' },
          title: { type: 'string', minLength: 1, maxLength: 120 },
          description: { type: 'string', minLength: 1, maxLength: 4000 },
          kind: { type: 'string', enum: ['code', 'analysis', 'review'] },
          agent: { type: 'string' },
          requirements: nonEmptyStrArray,
          acceptanceCriteria: nonEmptyStrArray,
          dependsOn: strArray,
          parallelGroup: { type: 'string' },
          requiredConsultations: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['agent', 'topic'],
              properties: { agent: { type: 'string' }, topic: { type: 'string', minLength: 1 } },
            },
          },
          approvalPoints: {
            type: 'array',
            items: {
              type: 'string',
              enum: ['plan', 'git_push', 'merge', 'deploy', 'destructive_command', 'sensitive_path', 'budget_exceeded'],
            },
          },
          budgetUsd: { type: 'number', exclusiveMinimum: 0, maximum: 50 },
        },
      },
    },
    risks: strArray,
  },
} as const;

export const REVIEW_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'tasks'],
  properties: {
    summary: { type: 'string', minLength: 1, maxLength: 4000 },
    tasks: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['taskId', 'decision', 'note'],
        properties: {
          taskId: { type: 'string' },
          decision: { type: 'string', enum: ['done', 'reopen'] },
          note: { type: 'string', maxLength: 2000 },
        },
      },
    },
  },
} as const;

export const SAMPLE_PLAN: Plan = {
  summary: 'Map the rules, implement them, add an independent fix and review.',
  risks: [],
  tasks: [
    {
      key: 'analysis',
      title: 'Analyse the mapping rules',
      description: 'Find where the mapping rules live and document them.',
      kind: 'analysis',
      agent: 'architect',
      requirements: ['List the files that hold the rules'],
      acceptanceCriteria: ['A written summary exists'],
      dependsOn: [],
      requiredConsultations: [],
      approvalPoints: [],
    },
    {
      key: 'mapping',
      title: 'Implement the mapping',
      description: 'Implement the new mapping rules.',
      kind: 'code',
      agent: 'developer',
      requirements: ['Follow the analysis'],
      acceptanceCriteria: ['Tests pass'],
      dependsOn: ['analysis'],
      requiredConsultations: [{ agent: 'architect', topic: 'where the mapping rules live' }],
      approvalPoints: [],
    },
    {
      key: 'verify',
      title: 'Verify the mapping',
      description: 'Independently verify the mapping change.',
      kind: 'review',
      agent: 'qa-engineer',
      requirements: ['Run the checks'],
      acceptanceCriteria: ['Verification notes recorded'],
      dependsOn: ['mapping'],
      requiredConsultations: [],
      approvalPoints: [],
    },
    {
      key: 'typo-fix',
      title: 'Fix a typo',
      description: 'Fix an unrelated typo in the docs.',
      kind: 'code',
      agent: 'developer',
      requirements: ['Fix the typo'],
      acceptanceCriteria: ['Typo gone'],
      dependsOn: [],
      requiredConsultations: [],
      approvalPoints: [],
    },
  ],
};

export type RosterEntry = { slug: string; active: boolean; system: boolean; allowed: boolean };

export function validatePlan(
  plan: Plan,
  roster: RosterEntry[],
): { ok: true; order: string[] } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const keys = new Set<string>();
  for (const t of plan.tasks) {
    if (keys.has(t.key)) errors.push(`duplicate task key ${t.key}`);
    keys.add(t.key);
  }
  const bySlug = new Map(roster.map((r) => [r.slug, r]));
  for (const t of plan.tasks) {
    for (const dep of t.dependsOn) if (!keys.has(dep)) errors.push(`task ${t.key} depends on unknown task ${dep}`);
    const a = bySlug.get(t.agent);
    if (!a) errors.push(`task ${t.key}: unknown agent ${t.agent}`);
    else if (!a.active) errors.push(`task ${t.key}: agent ${t.agent} is inactive`);
    else if (a.system) errors.push(`task ${t.key}: agent ${t.agent} is a system agent`);
    else if (!a.allowed) errors.push(`task ${t.key}: agent ${t.agent} is not allowed in this project`);
    for (const c of t.requiredConsultations) {
      if (!bySlug.has(c.agent)) errors.push(`task ${t.key}: consultation agent ${c.agent} unknown`);
    }
  }

  // DFS along dependsOn; report at most one cycle.
  const deps = new Map(plan.tasks.map((t) => [t.key, t.dependsOn.filter((d) => keys.has(d))]));
  const state = new Map<string, 1 | 2>();
  const stack: string[] = [];
  let cycle: string[] | undefined;
  const visit = (k: string): void => {
    state.set(k, 1);
    stack.push(k);
    for (const d of deps.get(k) ?? []) {
      if (cycle) return;
      if (state.get(d) === 1) {
        cycle = [...stack.slice(stack.indexOf(d)), d];
        return;
      }
      if (!state.has(d)) visit(d);
    }
    stack.pop();
    state.set(k, 2);
  };
  for (const t of plan.tasks) {
    if (cycle) break;
    if (!state.has(t.key)) visit(t.key);
  }
  if (cycle) errors.push(`dependency cycle: ${cycle.join(' -> ')}`);
  if (errors.length) return { ok: false, errors };

  // Kahn, ties by input order.
  const indeg = new Map(plan.tasks.map((t) => [t.key, t.dependsOn.length]));
  const order: string[] = [];
  const remaining = plan.tasks.map((t) => t.key);
  while (remaining.length) {
    const i = remaining.findIndex((k) => indeg.get(k) === 0);
    const k = remaining.splice(i, 1)[0]!;
    order.push(k);
    for (const t of plan.tasks) if (t.dependsOn.includes(k)) indeg.set(t.key, indeg.get(t.key)! - 1);
  }
  return { ok: true, order };
}
