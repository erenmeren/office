'use client';

import Link from 'next/link';
import { cva } from 'class-variance-authority';
import { ScanSearch } from 'lucide-react';
import { AgentAvatar } from '@/components/ui/agent-avatar';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Segmented } from '@/components/ui/segmented';
import { StatusPill } from '@/components/ui/status-pill';
import type { LiveSession } from '@/lib/queries';

export type SessionFilter = 'all' | 'running' | 'needs_you';
export interface SessionSelection {
  runId: string;
  subagentId?: string;
}

const FILTERS: { value: SessionFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'running', label: 'Running' },
  { value: 'needs_you', label: 'Needs you' },
];

export const matchesFilter = (s: LiveSession, f: SessionFilter) =>
  f === 'all' || (f === 'running' ? s.status === 'running' : s.status === 'waiting_approval');

const rowVariants = cva('flex w-full items-center gap-2.5 rounded-xl border px-2.5 py-2 text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50', {
  variants: { active: { true: 'border-violet/50 bg-violet/20', false: 'border-transparent hover:bg-white/7' } },
});

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const counts = (x: { commands: number; files: number }) => `${plural(x.commands, 'command')} · ${plural(x.files, 'file')}`;
export const subagentName = (s: { subagentType: string | null }) => s.subagentType ?? 'Subagent';

/** Live sessions with their native subagents nested under them. */
export function SessionList({
  sessions,
  filter,
  onFilter,
  selected,
  onSelect,
}: {
  sessions: LiveSession[];
  filter: SessionFilter;
  onFilter: (f: SessionFilter) => void;
  selected?: SessionSelection;
  onSelect: (s: SessionSelection) => void;
}) {
  const subs = sessions.reduce((n, s) => n + s.subagents.length, 0);
  const shown = sessions.filter((s) => matchesFilter(s, filter));
  const isActive = (runId: string, subagentId?: string) => selected?.runId === runId && selected.subagentId === subagentId;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Sessions</CardTitle>
        <CardDescription>
          {plural(sessions.length, 'agent')} · {plural(subs, 'subagent')}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <Segmented label="Filter sessions" options={FILTERS} value={filter} onChange={onFilter} />
        {shown.length === 0 ? (
          <p className="text-[13px] text-ink-3">{sessions.length ? 'No session matches this filter.' : 'No live sessions.'}</p>
        ) : (
          <ul aria-label="Sessions" className="flex flex-col gap-1">
            {shown.map((s) => (
              <li key={s.runId}>
                <div className="flex items-center gap-1">
                  <button type="button" aria-pressed={isActive(s.runId)} className={rowVariants({ active: isActive(s.runId) })} onClick={() => onSelect({ runId: s.runId })}>
                    <AgentAvatar name={s.agentName} size="md" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium text-ink">{s.agentName}</span>
                      <span className="block truncate font-mono text-xs text-ink-3">
                        {(s.sessionId ?? s.runId).slice(0, 8)} · {s.taskKey ?? s.kind}
                      </span>
                      <span className="block text-xs text-ink-2">{counts(s)}</span>
                    </span>
                    <StatusPill status={s.status} />
                  </button>
                  <Link
                    href={`/sessions/${s.runId}`}
                    aria-label={`Inspect ${s.agentName}`}
                    title="Open in the Agent Inspector"
                    className="grid size-8 shrink-0 place-items-center rounded-lg text-ink-3 outline-none hover:bg-white/7 hover:text-ink focus-visible:ring-3 focus-visible:ring-ring/50"
                  >
                    <ScanSearch className="size-4" aria-hidden />
                  </Link>
                </div>
                {s.subagents.length > 0 && (
                  <ul aria-label={`Subagents of ${s.agentName}`} className="ml-6 flex flex-col gap-1 border-l border-dashed border-white/15 pl-2">
                    {s.subagents.map((sub) => (
                      <li key={sub.id}>
                        <button
                          type="button"
                          aria-pressed={isActive(s.runId, sub.id)}
                          className={rowVariants({ active: isActive(s.runId, sub.id) })}
                          onClick={() => onSelect({ runId: s.runId, subagentId: sub.id })}
                        >
                          <AgentAvatar name={subagentName(sub)} subagent />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-ink">{subagentName(sub)}</span>
                            <span className="block truncate font-mono text-xs text-ink-3">
                              {sub.id.slice(0, 8)} · {sub.status}
                            </span>
                            <span className="block text-xs text-ink-2">{counts(sub)}</span>
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        )}
        <p className="text-xs text-ink-3">Dashed circles are native subagents. They live inside their parent agent&apos;s session and end with it.</p>
      </CardContent>
    </Card>
  );
}

/** List on the left, the selected session on the right. */
export function SessionColumns(props: React.ComponentProps<'div'>) {
  return <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]" {...props} />;
}
