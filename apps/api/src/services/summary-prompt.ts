import type { PrismaClient, TaskRun } from '@office/db';

const MAX_CHARS = 20_000;

// same rules as the web event log's summary(): tool + command/path, else the first 120 chars of text
function eventSummary(type: string, payload: unknown): string {
  const p = (payload ?? {}) as {
    tool?: unknown;
    input?: { command?: unknown; path?: unknown };
    text?: unknown;
    skill?: unknown;
    subagentType?: unknown;
  };
  if (type === 'agent.skill.invoked') return `skill ${typeof p.skill === 'string' ? p.skill : ''}`.trim();
  if (type === 'agent.subagent.spawned') return `subagent ${typeof p.subagentType === 'string' ? p.subagentType : ''}`.trim();
  if (typeof p.tool === 'string') {
    const arg = p.input?.command ?? p.input?.path;
    return `${p.tool} ${typeof arg === 'string' ? arg.slice(0, 80) : ''}`.trim();
  }
  if (typeof p.text === 'string') return p.text.slice(0, 120);
  return '';
}

/** The evidence of a finished run, as the prompt for its summary run; capped at 20 000 chars. */
export async function summaryPrompt(prisma: PrismaClient, run: TaskRun): Promise<string> {
  const [task, session] = await Promise.all([
    run.taskId ? prisma.task.findUnique({ where: { id: run.taskId } }) : null,
    prisma.agentSession.findUnique({ where: { runId: run.id } }),
  ]);
  const events = session
    ? await prisma.sessionEvent.findMany({ where: { sessionId: session.id }, orderBy: { seq: 'asc' }, take: 200 })
    : [];
  const sent = session ? await prisma.message.findMany({ where: { senderSessionId: session.id }, orderBy: { createdAt: 'asc' } }) : [];
  // shortcut: "received" = replies to this run's messages; inbox reads are not linked to a run yet
  const received = sent.length
    ? await prisma.message.findMany({ where: { inReplyToId: { in: sent.map((m) => m.id) } }, orderBy: { createdAt: 'asc' } })
    : [];
  const parts = [
    `Summarize run ${run.id} (status ${run.status}). Evidence refs: run ${run.id}${task ? `, task ${task.id}` : ''}.`,
    task ? `## Task\n${task.title}\n\n${task.description}` : '',
    `## Result\n${run.resultText ?? '(no result text)'}${run.error ? `\nError: ${run.error}` : ''}`,
    events.length ? `## Events\n${events.map((e) => `${e.seq} ${e.type} ${eventSummary(e.type, e.payload)}`.trim()).join('\n')}` : '',
    sent.length ? `## Messages sent\n${sent.map((m) => `- [${m.id}] ${m.type}: ${m.body}`).join('\n')}` : '',
    received.length ? `## Messages received\n${received.map((m) => `- [${m.id}] ${m.type}: ${m.body}`).join('\n')}` : '',
  ];
  return parts.filter(Boolean).join('\n\n').slice(0, MAX_CHARS);
}
