import { z } from 'zod';
import { MemoryProposalSchema, MemoryTypeSchema } from './memory.js';

const body = z.string().min(1).max(8000);

// `input` is a raw shape because the Agent SDK's tool() helper takes one.
// `to` is an agent slug (list_agents shows them).
export const OFFICE_TOOLS = {
  send_message: {
    description:
      'Send a message to another agent by slug. With awaitReply: true the current turn ends and the reply arrives as the next user message; otherwise the call returns at once.',
    input: {
      to: z.string(),
      body,
      type: z.enum(['message', 'question', 'artifact']).default('message'),
      awaitReply: z.boolean().default(false),
      taskId: z.string().optional(),
    },
  },
  reply_message: {
    description: 'Reply to a message you received, identified by its message id.',
    input: { messageId: z.string(), body },
  },
  read_inbox: {
    description:
      'List messages waiting for you. Reading acknowledges them, so they will not be returned again.',
    input: { limit: z.number().int().positive().max(50).default(20) },
  },
  get_conversation: {
    description: 'Read the recent messages of a conversation by its id.',
    input: { conversationId: z.string(), limit: z.number().int().positive().max(100).default(50) },
  },
  list_agents: {
    description: 'List the agents in this project with their slugs, roles and availability.',
    input: {},
  },
  request_help: {
    description: 'Ask another agent (by slug) for help with your current work. Waits for the answer by default.',
    input: { to: z.string(), body, awaitReply: z.boolean().default(true) },
  },
  handoff_task: {
    description: 'Hand your current task over to another agent (by slug) with a note describing the state of the work.',
    input: { to: z.string(), body },
  },
  escalate_to_chief: {
    description: 'Escalate a blocker or decision to the Chief. Waits for the answer by default.',
    input: { body, awaitReply: z.boolean().default(true) },
  },
  search_memory: {
    description: 'Search verified project memory by keyword, optionally filtered by memory type.',
    input: {
      query: z.string().min(1),
      type: MemoryTypeSchema.optional(),
      limit: z.number().int().positive().max(20).default(10),
    },
  },
  read_memory: {
    description: 'Read one memory entry in full, including its sources.',
    input: { id: z.string() },
  },
  propose_memory: {
    description:
      'Propose a durable memory entry (decision, convention, contract, known issue or lesson) with sources. It stays proposed until verified.',
    input: MemoryProposalSchema.shape,
  },
  get_task_history: {
    description: 'Read summaries of earlier work on a task (defaults to the current task).',
    input: { taskId: z.string().optional(), limit: z.number().int().positive().max(20).default(5) },
  },
  get_project_decisions: {
    description: 'List the verified decisions recorded for this project.',
    input: { limit: z.number().int().positive().max(50).default(20) },
  },
  submit_summary: {
    description: 'Submit the final summary of the run together with up to 10 memory proposals.',
    input: { summary: body, proposals: z.array(MemoryProposalSchema).max(10).default([]) },
  },
  get_task_evidence: {
    description:
      "Read a task's recorded evidence: its runs with git summary, check results, summaries and message counts (Chief review only).",
    input: { taskId: z.string() },
  },
  review_task: {
    description:
      'Record your review decision for a task: done, reopen, failed (when it used all its attempts), or blocked when only the owner can unblock it (network access, credentials, missing input): the task waits for the owner with your note and no attempt is used (Chief review only).',
    input: { taskId: z.string(), decision: z.enum(['done', 'reopen', 'failed', 'blocked']), note: z.string().max(2000).default('') },
  },
  // Conductor only: records across projects, never a project's files
  list_projects: {
    description: 'List the projects with their slug, name, team and number of live missions (Conductor only).',
    input: {},
  },
  get_project: {
    description: "Read one project by slug: its team, recent missions with status and summary, and verified decisions (Conductor only).",
    input: { project: z.string() },
  },
  search_project_memory: {
    description: "Search one project's verified memory by keyword or meaning (Conductor only).",
    input: { project: z.string(), query: z.string().min(1), limit: z.number().int().positive().max(20).default(10) },
  },
  create_project: {
    description:
      'Create a new, empty project for the work asked in a new tab, one that has no project yet; the tab then belongs to that project. Office makes its folder and the whole team can work in it; the slug is derived from the name. Then open the mission in it with create_mission (Conductor only).',
    input: { name: z.string().trim().min(1).max(60) },
  },
  create_mission: {
    description:
      "Open a mission in the project this tab belongs to (by slug); a mission for another project is refused. The project's Chief plans it and the project's approval policy applies (Conductor only).",
    input: {
      project: z.string(),
      request: z.string().min(1).max(8000),
      title: z.string().min(1).max(120).optional(),
      budgetUsd: z.number().positive().optional(),
    },
  },
  list_missions: {
    description: 'List recent missions, optionally of one project (by slug), with status and what each waits for (Conductor only).',
    input: { project: z.string().optional(), limit: z.number().int().positive().max(50).default(20) },
  },
  get_mission: {
    description: "Read one mission: status, its tasks with status and agent, the plan summary and the final summary (Conductor only).",
    input: { missionId: z.string() },
  },
} as const satisfies Record<string, { description: string; input: z.ZodRawShape }>;

export type OfficeToolName = keyof typeof OFFICE_TOOLS;
export const OFFICE_TOOL_NAMES = Object.keys(OFFICE_TOOLS) as OfficeToolName[];
export const MCP_SERVER_NAME = 'office';
export const mcpToolName = (name: OfficeToolName) => `mcp__${MCP_SERVER_NAME}__${name}`;

export const ToolCallResultSchema = z
  .object({ ok: z.literal(true), result: z.unknown(), suspend: z.boolean().optional() })
  .or(z.object({ ok: z.literal(false), error: z.string(), code: z.string() }));
export type ToolCallResult = z.infer<typeof ToolCallResultSchema>;

export function parseToolArgs(name: OfficeToolName, args: unknown): Record<string, unknown> {
  return z.object(OFFICE_TOOLS[name].input).parse(args);
}
