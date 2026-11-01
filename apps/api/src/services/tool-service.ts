import { ZodError } from 'zod';
import type { AgentSession, PrismaClient, TaskRun } from '@office/db';
import {
  OFFICE_TOOL_NAMES,
  parseToolArgs,
  type MemorySourceInput,
  type OfficeToolName,
  type ToolCallResult,
} from '@office/shared';
import type { Config } from '../config.js';
import { HttpError } from '../lib/errors.js';
import type { EventHub } from './event-hub.js';
import {
  createEntry,
  getEntry,
  projectDecisions,
  searchMemory,
  taskHistory,
} from './memory-service.js';
import type { Db } from './task-service.js';
import { MessageError, readInbox, sendMessage, toMessageView, type SendInput } from './message-service.js';

type RunKind = TaskRun['kind'];
type Args = Record<string, any>; // validated by parseToolArgs, which returns a loose record

class ToolError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

const MESSAGING_AND_MEMORY = OFFICE_TOOL_NAMES.filter((n) => n !== 'submit_summary');

export function toolsForKind(kind: RunKind): OfficeToolName[] {
  return kind === 'summary' ? ['submit_summary'] : [...MESSAGING_AND_MEMORY];
}

const fail = (code: string, error: string): ToolCallResult => ({ ok: false, code, error });

export async function executeTool(
  prisma: PrismaClient,
  hub: EventHub,
  config: Config,
  ctx: { run: TaskRun; session: AgentSession },
  name: string,
  rawArgs: unknown,
): Promise<ToolCallResult> {
  if (!(OFFICE_TOOL_NAMES as string[]).includes(name) || !toolsForKind(ctx.run.kind).includes(name as OfficeToolName)) {
    return fail('unknown_tool', `unknown tool: ${name}`);
  }
  try {
    const args = parseToolArgs(name as OfficeToolName, rawArgs);
    return { ok: true, ...(await run(prisma, hub, config, ctx, name as OfficeToolName, args)) };
  } catch (err) {
    if (err instanceof ZodError) return fail('invalid_args', err.message);
    if (err instanceof ToolError || err instanceof MessageError) return fail(err.code, err.message);
    if (err instanceof HttpError) return fail(err.status === 404 ? 'not_found' : err.code, err.message);
    throw err;
  }
}

async function run(
  prisma: PrismaClient,
  hub: EventHub,
  config: Config,
  { run, session }: { run: TaskRun; session: AgentSession },
  name: OfficeToolName,
  args: Args,
): Promise<{ result: unknown; suspend?: boolean }> {
  const { projectId, agentId } = session;
  const taskId = run.taskId ?? undefined;

  const slugToId = async (slug: string) => {
    const a = await prisma.agent.findFirst({ where: { slug, isActive: true, isSystem: false }, select: { id: true } });
    if (!a) throw new MessageError('unknown_recipient', `unknown agent: ${slug}`);
    return a.id;
  };

  const post = async (input: Partial<SendInput> & Pick<SendInput, 'type' | 'body'>) => {
    if (input.awaitReply && run.kind === 'inbox') throw new ToolError('not_allowed', 'inbox runs cannot await a reply');
    const { message, deliveries } = await sendMessage(prisma, config.messageLimits, {
      projectId,
      senderAgentId: agentId,
      senderSessionId: session.id,
      senderRunId: run.id,
      taskId,
      recipientAgentIds: [],
      ...input,
    });
    const view = toMessageView({ ...message, deliveries });
    for (const topic of [`conversation:${view.conversationId}`, 'global']) {
      hub.publish(topic, { type: 'message.created', topic, message: view });
    }
    const result = { messageId: message.id, conversationId: message.conversationId };
    if (!input.awaitReply) return { result };
    await prisma.taskRun.update({ where: { id: run.id }, data: { waitingForMessageId: message.id } });
    return {
      result: { ...result, note: 'Your turn ends now; the reply arrives as your next user message.' },
      suspend: true,
    };
  };

  const propose = (db: Db, p: Args, author: string, rid: string, tid: string | undefined) => {
    const sources: MemorySourceInput[] = [...p.sources, { kind: 'run', ref: rid }];
    return createEntry(db, {
      projectId,
      scope: p.scope,
      agentId: p.scope === 'agent' ? author : undefined,
      type: p.type,
      title: p.title,
      content: p.content,
      authorType: 'agent',
      authorAgentId: author,
      status: 'proposed',
      taskId: tid,
      runId: rid,
      sources,
    });
  };
  const memoryChanged = (entryId: string, status: 'proposed' | 'verified') =>
    hub.publish('global', { type: 'memory.changed', topic: 'global', entryId, status });

  switch (name) {
    case 'send_message':
      return post({
        type: args.type,
        body: args.body,
        recipientAgentIds: [await slugToId(args.to)],
        awaitReply: args.awaitReply,
        taskId: args.taskId ?? taskId,
      });
    case 'request_help':
      return post({
        type: 'help_request',
        body: args.body,
        recipientAgentIds: [await slugToId(args.to)],
        awaitReply: args.awaitReply,
      });
    case 'escalate_to_chief':
      return post({
        type: 'escalation',
        body: args.body,
        recipientAgentIds: [await slugToId('chief')],
        awaitReply: args.awaitReply,
      });
    case 'handoff_task': {
      const to = await slugToId(args.to);
      const out = await post({ type: 'handoff', body: args.body, recipientAgentIds: [to] });
      // the task continues with the new agent on its next run
      if (taskId) await prisma.task.updateMany({ where: { id: taskId, agentId }, data: { agentId: to } });
      return out;
    }
    case 'reply_message': {
      const parent = await prisma.message.findFirst({ where: { id: args.messageId, projectId } });
      if (!parent) throw new MessageError('not_found', 'message not found');
      return post({
        type: 'reply',
        body: args.body,
        inReplyToId: parent.id,
        conversationId: parent.conversationId,
        taskId: parent.taskId ?? taskId,
      });
    }
    case 'read_inbox':
      return { result: { messages: await readInbox(prisma, { agentId, projectId, limit: args.limit }) } };
    case 'get_conversation': {
      const c = await prisma.conversation.findFirst({ where: { id: args.conversationId, projectId } });
      if (!c) throw new MessageError('not_found', 'conversation not found');
      const rows = await prisma.message.findMany({
        where: { conversationId: c.id },
        orderBy: { createdAt: 'desc' },
        take: args.limit,
        include: { deliveries: true },
      });
      return {
        result: {
          id: c.id,
          kind: c.kind,
          title: c.title,
          taskId: c.taskId,
          messages: rows.reverse().map(toMessageView),
        },
      };
    }
    case 'list_agents': {
      const agents = await prisma.agent.findMany({
        where: { isActive: true, isSystem: false },
        orderBy: { slug: 'asc' },
        select: { slug: true, name: true, role: true },
      });
      return { result: { agents } };
    }
    case 'search_memory':
      return {
        result: { entries: await searchMemory(prisma, { projectId, q: args.query, type: args.type, status: 'verified', limit: args.limit }) },
      };
    case 'read_memory': {
      const e = await getEntry(prisma, args.id, projectId);
      if (!(e.status === 'verified' || (e.status === 'proposed' && e.authorAgentId === agentId))) throw new HttpError(404, 'not_found');
      return { result: e };
    }
    case 'propose_memory': {
      const e = await propose(prisma, args, agentId, run.id, taskId);
      memoryChanged(e.id, 'proposed');
      return { result: { entryId: e.id, status: 'proposed' } };
    }
    case 'get_task_history':
      return { result: { entries: await taskHistory(prisma, { projectId, taskId: args.taskId ?? taskId, limit: args.limit }) } };
    case 'get_project_decisions':
      return { result: { entries: await projectDecisions(prisma, { projectId, limit: args.limit }) } };
    case 'submit_summary': {
      if (!run.summaryOfRunId) throw new ToolError('invalid_state', 'run has no summarized run');
      const target = await prisma.taskRun.findFirst({
        where: { id: run.summaryOfRunId, projectId },
        include: { task: true },
      });
      if (!target) throw new ToolError('invalid_state', 'summarized run not found');
      const created = await prisma.$transaction(async (tx) => {
        // serialize concurrent submits for the same run, then check
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`sum:${target.id}`}))::text`;
        if (await tx.memoryEntry.count({ where: { runId: target.id, type: 'task_summary' } })) {
          throw new ToolError('already_submitted', 'a summary was already submitted for this run');
        }
        const entry = await createEntry(tx, {
          projectId,
          scope: 'project',
          type: 'task_summary',
          title: target.task ? `Summary: ${target.task.title}` : `Summary of run ${target.id.slice(0, 8)}`,
          content: args.summary,
          authorType: 'system',
          status: 'verified',
          taskId: target.taskId ?? undefined,
          runId: target.id,
          sources: [{ kind: 'run', ref: target.id }, ...(target.taskId ? [{ kind: 'task' as const, ref: target.taskId }] : [])],
        });
        const proposals = [];
        for (const p of args.proposals as Args[]) {
          proposals.push(await propose(tx, p, target.agentId, target.id, target.taskId ?? undefined));
        }
        return { entry, proposals };
      });
      memoryChanged(created.entry.id, 'verified');
      for (const p of created.proposals) memoryChanged(p.id, 'proposed');
      return { result: { entryId: created.entry.id, proposalIds: created.proposals.map((p) => p.id) } };
    }
  }
}
