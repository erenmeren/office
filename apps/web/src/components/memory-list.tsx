'use client';

import { cva } from 'class-variance-authority';
import { X } from 'lucide-react';
import { AgentAvatar, OwnerAvatar } from '@/components/ui/agent-avatar';
import { Button } from '@/components/ui/button';
import { SearchInput } from '@/components/ui/search-input';
import { Segmented } from '@/components/ui/segmented';
import { MemoryStatusTag, TypeTag } from '@/components/ui/type-tag';
import { taskCode } from '@/components/task-detail';
import { sourceLabel, TYPE_FILTERS, type TypeFilter } from '@/lib/memory';
import type { Agent, MemoryEntry } from '@/lib/queries';

const rowVariants = cva('flex w-full flex-col gap-1.5 rounded-xl border px-3 py-2.5 text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50', {
  variants: { active: { true: 'border-violet/50 bg-violet/20', false: 'border-transparent hover:bg-white/7' } },
});

export function Author({ entry, agents }: { entry: MemoryEntry; agents: Agent[] }) {
  if (entry.authorType === 'user') return <><OwnerAvatar />You</>;
  if (entry.authorType === 'system') return <span className="text-ink-3">System</span>;
  const a = agents.find((x) => x.id === entry.authorAgentId);
  return a ? <><AgentAvatar name={a.name} identity={a.slug} />{a.name}</> : <span className="text-ink-3">Agent</span>;
}

/** Search box, type pills and the review banner. */
export function MemorySearch({
  q,
  onQ,
  type,
  onType,
  proposed,
  reviewing,
  onReview,
  taskId,
  onClearTask,
}: {
  q: string;
  onQ: (q: string) => void;
  type: TypeFilter;
  onType: (t: TypeFilter) => void;
  proposed: number;
  reviewing: boolean;
  onReview: (on: boolean) => void;
  /** the task filter from `?taskId=`, shown as a chip that clears it */
  taskId?: string | null;
  onClearTask: () => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      <SearchInput aria-label="Search memory" placeholder="Search memory" value={q} onChange={(e) => onQ(e.target.value)} />
      <Segmented label="Filter by type" options={[...TYPE_FILTERS]} value={type} onChange={onType} />
      {(proposed > 0 || reviewing) && (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-amber/45 bg-amber/10 px-3 py-2 text-sm">
          <span className="text-amber">{proposed} entries need review.</span>
          <Button size="sm" variant="secondary" onClick={() => onReview(!reviewing)}>
            {reviewing ? 'Show all' : 'Review now'}
          </Button>
        </div>
      )}
      {taskId && (
        <Button variant="secondary" size="sm" className="self-start font-mono" aria-label={`Task ${taskId.slice(0, 8)}, clear filter`} onClick={onClearTask}>
          Task {taskId.slice(0, 8)}
          <X data-icon="inline-end" aria-hidden />
        </Button>
      )}
    </div>
  );
}

export function MemoryList({
  entries,
  total,
  searching,
  agents,
  selectedId,
  onSelect,
}: {
  entries: MemoryEntry[];
  total: number;
  searching: boolean;
  agents: Agent[];
  selectedId?: string;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-medium">
          {entries.length} of {total} entries
        </span>
        <span className="text-xs text-ink-3">{searching ? 'Sorted by relevance' : 'Newest first'}</span>
      </div>
      <ul className="flex flex-col gap-1">
        {entries.map((e) => (
          <li key={e.id}>
            <button type="button" aria-current={e.id === selectedId} onClick={() => onSelect(e.id)} className={rowVariants({ active: e.id === selectedId })}>
              <span className="flex flex-wrap items-center gap-1.5">
                <TypeTag type={e.type} />
                <MemoryStatusTag status={e.status} />
                <span className="ml-auto font-mono text-xs text-ink-3">
                  v{e.version} · {new Date(e.updatedAt).toLocaleString()}
                </span>
              </span>
              <span className="font-medium">{e.title}</span>
              <span className="line-clamp-2 text-[13px] text-ink-2">{e.content}</span>
              <span className="flex flex-wrap items-center gap-2 text-xs text-ink-2">
                <Author entry={e} agents={agents} />
                {e.taskId && <span className="rounded-md bg-white/10 px-1.5 font-mono text-[11px]">{taskCode(e.taskId)}</span>}
                {e.sources.slice(0, 3).map((s) => (
                  <span key={s.id} className="font-mono text-[11px] text-ink-3">
                    {sourceLabel(s)}
                  </span>
                ))}
              </span>
            </button>
          </li>
        ))}
        {entries.length === 0 && <li className="px-2 py-4 text-sm text-ink-3">No memory entries.</li>}
      </ul>
    </div>
  );
}
