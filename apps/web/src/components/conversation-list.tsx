'use client';

import { useState } from 'react';
import { cva } from 'class-variance-authority';
import { cn } from 'cn';
import { AgentAvatar, OwnerAvatar } from '@/components/ui/agent-avatar';
import { SearchInput } from '@/components/ui/search-input';
import { Segmented } from '@/components/ui/segmented';
import { taskCode } from '@/components/task-detail';
import { conversationTitle, timeOf } from '@/lib/conversations';
import { useMessageSearch, type Agent, type Conversation, type ConversationKind } from '@/lib/queries';

export type Filter = 'all' | ConversationKind;
const FILTERS: { value: Filter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'direct', label: 'Direct' },
  { value: 'task', label: 'Task' },
  { value: 'group', label: 'Group' },
  { value: 'human', label: 'You' },
];
const KIND_TAG: Record<ConversationKind, string> = { task: 'Task', direct: 'Direct', group: 'Group', human: 'You' };

const rowVariants = cva('flex w-full gap-2.5 rounded-xl border px-3 py-2.5 text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50', {
  variants: { active: { true: 'border-violet/50 bg-violet/20', false: 'border-transparent hover:bg-white/7' } },
});

export function ConversationList({
  projectId,
  conversations,
  agents,
  selectedId,
  filter,
  onFilter,
  onSelect,
}: {
  projectId?: string;
  conversations: Conversation[];
  agents: Agent[];
  selectedId?: string;
  filter: Filter;
  onFilter: (f: Filter) => void;
  onSelect: (id: string) => void;
}) {
  const [q, setQ] = useState('');
  const search = useMessageSearch(projectId, q);
  const hits = q.trim().length > 1 ? new Set(search.data?.map((m) => m.conversationId)) : undefined;
  const rows = hits ? conversations.filter((c) => hits.has(c.id)) : conversations;

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <SearchInput aria-label="Search messages" placeholder="Search messages" value={q} onChange={(e) => setQ(e.target.value)} />
      <Segmented label="Filter conversations" options={FILTERS} value={filter} onChange={onFilter} />
      <ul className="flex flex-col gap-1">
        {rows.map((c) => {
          const last = c.lastMessage;
          const sender = last?.senderAgentId ? agents.find((a) => a.id === last.senderAgentId) : undefined;
          return (
            <li key={c.id}>
              <button type="button" aria-current={c.id === selectedId} onClick={() => onSelect(c.id)} className={rowVariants({ active: c.id === selectedId })}>
                {sender ? <AgentAvatar name={sender.name} identity={sender.slug} /> : <OwnerAvatar />}
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate font-medium">{conversationTitle(c, agents)}</span>
                    {last && <span className="font-mono text-xs text-ink-3">{timeOf(last.createdAt)}</span>}
                  </span>
                  <span className="truncate text-[13px] text-ink-2">{last?.body ?? 'No messages yet'}</span>
                  <span className="flex items-center gap-1.5 text-[11px] text-ink-3">
                    <span className="rounded-full border border-white/22 px-1.5">{KIND_TAG[c.kind]}</span>
                    {c.taskId && <span className="rounded-md bg-white/10 px-1.5 font-mono">{taskCode(c.taskId)}</span>}
                  </span>
                </span>
                {c.unreadForOwner > 0 && (
                  <span className={cn('mt-1.5 size-2 shrink-0 rounded-full bg-pink')}>
                    <span className="sr-only">{c.unreadForOwner} unread</span>
                  </span>
                )}
              </button>
            </li>
          );
        })}
        {rows.length === 0 && <li className="px-2 py-4 text-sm text-ink-3">No conversations.</li>}
      </ul>
    </div>
  );
}
