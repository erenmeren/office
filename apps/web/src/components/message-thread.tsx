'use client';

import Link from 'next/link';
import { AgentAvatar, OwnerAvatar } from '@/components/ui/agent-avatar';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { MessageBubble } from '@/components/ui/message-bubble';
import { StatusDot, StatusPill } from '@/components/ui/status-pill';
import { MessageComposer } from '@/components/message-composer';
import { taskCode } from '@/components/task-detail';
import { conversationTitle, deliveryLine, groupByDay, messageTypeLabel, timeOf } from '@/lib/conversations';
import { useTasks, type Agent, type Conversation, type MessageView } from '@/lib/queries';

const KIND_LABEL = { task: 'Task thread', direct: 'Direct thread', group: 'Group thread', human: 'Thread with you' } as const;

function Bubble({ m, agents, conv }: { m: MessageView; agents: Agent[]; conv: Conversation }) {
  const sender = m.senderAgentId ? agents.find((a) => a.id === m.senderAgentId) : undefined;
  const owner = !sender;
  const recipients = m.deliveries.map((d) => (d.recipientUserId ? 'You' : (agents.find((a) => a.id === d.recipientAgentId)?.name ?? 'Agent')));
  const to = recipients.length ? recipients.join(', ') : conv.kind === 'group' || conv.kind === 'task' ? 'everyone' : '';
  const from = sender?.name ?? 'You';
  return (
    <MessageBubble
      from={owner ? 'owner' : 'agent'}
      avatar={sender ? <AgentAvatar name={sender.name} identity={sender.slug} /> : <OwnerAvatar />}
      heading={to ? `${from} to ${to}` : from}
      time={timeOf(m.createdAt)}
      typeLabel={messageTypeLabel(m.type)}
      body={m.body}
      delivery={deliveryLine(m)}
    />
  );
}

export function MessageThread({ conversation, agents }: { conversation: Conversation & { messages: MessageView[] }; agents: Agent[] }) {
  const members = agents.filter((a) => conversation.agentIds.includes(a.id));
  return (
    <section className="flex min-w-0 flex-col gap-3" aria-label="Thread">
      <header className="flex flex-wrap items-center gap-3 border-b border-white/10 pb-3">
        <div className="min-w-0 flex-1">
          <h2 className="truncate font-heading text-lg font-semibold">{conversationTitle(conversation, agents)}</h2>
          <p className="flex items-center gap-2 text-xs text-ink-3">
            {KIND_LABEL[conversation.kind]}
            {conversation.taskId && <span className="rounded-md bg-white/10 px-1.5 font-mono">{taskCode(conversation.taskId)}</span>}
          </p>
        </div>
        <div className="flex -space-x-1.5">
          {members.map((a) => (
            <AgentAvatar key={a.id} name={a.name} identity={a.slug} />
          ))}
        </div>
      </header>
      <div className="flex max-h-[520px] min-h-[240px] flex-col gap-4 overflow-y-auto pr-1">
        {groupByDay(conversation.messages).map((g) => (
          <div key={g.day} className="flex flex-col gap-3">
            <div className="text-center font-mono text-xs text-ink-3">{g.day}</div>
            {g.messages.map((m) => (
              <Bubble key={m.id} m={m} agents={agents} conv={conversation} />
            ))}
          </div>
        ))}
        {conversation.messages.length === 0 && <p className="text-sm text-ink-3">No messages yet.</p>}
      </div>
      <MessageComposer conversationId={conversation.id} />
    </section>
  );
}

/** Side cards: the linked task and who is in the thread. */
export function ConversationSide({ conversation, agents }: { conversation: Conversation; agents: Agent[] }) {
  const tasks = useTasks();
  const task = conversation.taskId ? tasks.data?.find((t) => t.id === conversation.taskId) : undefined;
  const live = conversation.activeRun?.status === 'running';
  return (
    <div className="flex flex-col gap-3">
      {task && (
        <Card size="sm">
          <CardHeader>
            <CardTitle>Linked task</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <Link href={`/tasks/${task.id}`} className="block font-medium hover:underline">
              {task.title}
            </Link>
            <StatusPill status={task.status} />
          </CardContent>
        </Card>
      )}
      <Card size="sm">
        <CardHeader>
          <CardTitle>Participants</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {agents
            .filter((a) => conversation.agentIds.includes(a.id))
            .map((a) => (
              <div key={a.id} className="flex items-center gap-2.5">
                <AgentAvatar name={a.name} identity={a.slug} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{a.name}</span>
                  <span className="block truncate text-xs text-ink-3">{a.role}</span>
                </span>
                <StatusDot tone={live ? 'live' : 'idle'} />
              </div>
            ))}
        </CardContent>
      </Card>
    </div>
  );
}
