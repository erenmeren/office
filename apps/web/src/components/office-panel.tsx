'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { approvalSubject } from '@/components/approval-card';
import { AgentAvatar } from '@/components/ui/agent-avatar';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Segmented } from '@/components/ui/segmented';
import { StatusPill } from '@/components/ui/status-pill';
import { post } from '@/lib/api';
import { agentGradient } from '@/lib/agent-identity';
import { approvalTypeLabel } from '@/lib/missions';
import type { OfficeRoom } from '@/lib/office';
import { useActivity, useApprovals, useSession, type ApprovalView } from '@/lib/queries';
import { clockTime, elapsed } from '@/lib/sessions';

/** Pending approvals of the project, decided in place; the agent is the room whose run asked. */
export function OfficeApprovals({ projectId, rooms }: { projectId: string; rooms: OfficeRoom[] }) {
  const qc = useQueryClient();
  const approvals = useApprovals(projectId, 'pending').data ?? [];
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const decide = async (items: ApprovalView[], path: 'approve' | 'deny') => {
    setBusy(true);
    setError('');
    try {
      for (const a of items) await post(`/approvals/${a.id}/${path}`, path === 'approve' ? { scope: 'once' } : undefined);
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
      await Promise.all(['approvals', 'overview', 'sessions', 'missions'].map((k) => qc.invalidateQueries({ queryKey: [k] })));
    }
  };
  const roomOf = (a: ApprovalView) => rooms.find((r) => r.runId === a.runId);
  return (
    <Card size="sm" className="gap-0 border-amber/28 bg-linear-to-br from-amber/10 to-white/4 py-0">
      <div className="flex items-center gap-2.5 px-4 pt-3 pb-2.5">
        <span className="size-2 rounded-full bg-amber shadow-[0_0_10px_#ffc247]" />
        <span className="flex-1 font-heading text-[15px] font-semibold">Approvals</span>
        <span className="rounded-full bg-amber/18 px-2 py-0.5 font-mono text-[11px] font-semibold text-amber">{approvals.length} pending</span>
        {approvals.length > 0 && (
          <Button size="xs" disabled={busy} className="border-0 bg-amber from-amber to-amber text-on-brand shadow-none hover:bg-[#ffd27a]" onClick={() => decide(approvals, 'approve')}>
            Approve all
          </Button>
        )}
      </div>
      {approvals.map((a) => {
        const room = roomOf(a);
        return (
          <div key={a.id} className="flex flex-col gap-1.5 border-t border-white/8 px-4 pt-2.5 pb-3">
            <div className="flex items-center gap-2">
              <AgentAvatar name={room?.name ?? 'Agent'} identity={room?.slug} size="sm" />
              <span className="text-[12.5px] font-semibold">{room?.name ?? 'Agent'}</span>
              <span className="rounded-[5px] bg-amber/15 px-1.5 py-0.5 font-mono text-[10px] text-amber">{approvalTypeLabel(a.type)}</span>
              <span className="ml-auto font-mono text-[10px] text-ink-3">{clockTime(a.createdAt)}</span>
            </div>
            <div className="truncate font-mono text-[11.5px] text-ink">{approvalSubject(a)}</div>
            <div className="line-clamp-2 text-[11px] leading-[1.35] text-ink-3">{a.reason}</div>
            <div className="mt-0.5 flex gap-2">
              <Button size="sm" variant="destructive" className="flex-1 border-rose/40" disabled={busy} onClick={() => decide([a], 'deny')}>
                Deny
              </Button>
              <Button size="sm" className="flex-1" disabled={busy} onClick={() => decide([a], 'approve')}>
                Approve
              </Button>
            </div>
          </div>
        );
      })}
      {approvals.length === 0 && (
        <div className="flex items-center gap-2.5 border-t border-white/8 px-4 pt-3 pb-3.5 text-xs text-ink-3">
          <span className="grid size-[22px] place-items-center rounded-full bg-mint/15 text-xs font-bold text-mint">✓</span>All clear — nothing waiting on you
        </div>
      )}
      {error && <p className="px-4 pb-3 text-xs text-destructive">{error}</p>}
    </Card>
  );
}

const EVENT_COLOR: [string, string][] = [
  ['agent.tool', '#4fe3ff'],
  ['agent.file', '#b39dff'],
  ['agent.subagent', '#ff6ad5'],
  ['agent.command', '#3df5c8'],
  ['agent.message', '#ffc247'],
  ['agent.waiting', '#ffc247'],
];
const eventColor = (type: string) => EVENT_COLOR.find(([k]) => type.startsWith(k))?.[1] ?? '#b6b4d8';

type Tab = 'events' | 'commands' | 'files';

/** The selected room's agent: its run, the task, three numbers, and the run's events, commands or files. */
export function OfficeAgentPanel({ room, projectId, now }: { room: OfficeRoom; projectId: string; now: number }) {
  const [tab, setTab] = useState<Tab>('events');
  const [c1, c2] = agentGradient(room.slug);
  const events = (useActivity(projectId).data ?? []).filter((e) => e.agentId === room.agentId).slice(0, 40);
  const session = useSession(room.runId ?? undefined).data;
  const stat = (label: string, value: string) => (
    <div className="rounded-[10px] bg-white/5 px-2.5 py-2">
      <div className="text-[10px] tracking-[0.04em] text-ink-3 uppercase">{label}</div>
      <div className="mt-0.5 font-mono text-sm">{value}</div>
    </div>
  );
  return (
    <Card size="sm" className="min-h-0 flex-1 gap-0 py-0">
      <div className="h-[3px]" style={{ background: `linear-gradient(90deg,${c1},${c2})` }} />
      <div className="flex items-center gap-3 px-4 pt-3.5 pb-3">
        <AgentAvatar name={room.name} identity={room.slug} size="lg" />
        <div className="min-w-0 flex-1">
          <div className="font-heading text-[17px] font-semibold">{room.name}</div>
          <div className="truncate font-mono text-[11px] text-ink-3">
            {room.workerName ?? 'no worker'} · {room.runId ? `run ${room.runId.slice(0, 8)}` : 'no run'}
          </div>
        </div>
        <StatusPill status={room.status} />
      </div>
      <div className="mx-4 rounded-xl border border-white/10 bg-white/6 px-3 py-2.5 text-[12.5px] leading-[1.35] text-ink-2">{room.task}</div>
      <div className="grid grid-cols-3 gap-2 px-4 py-3">
        {stat('Elapsed', room.startedAt ? elapsed(now - Date.parse(room.startedAt)) : '—')}
        {stat('Cost', `$${room.costUsd.toFixed(2)}`)}
        {stat('Subagents', String(room.subs.length))}
      </div>
      <Segmented
        label="Panel"
        className="mx-4 flex rounded-[10px] border-0 bg-white/5 *:flex-1 *:rounded-lg"
        value={tab}
        onChange={setTab}
        options={[
          { value: 'events', label: 'Events' },
          { value: 'commands', label: 'Commands' },
          { value: 'files', label: 'Files' },
        ]}
      />
      <div className="mt-2 max-h-[360px] min-h-[120px] flex-1 overflow-y-auto">
        {tab === 'events' &&
          (events.length === 0 ? (
            <p className="px-4 py-3 text-xs text-ink-3">No events from this agent yet.</p>
          ) : (
            events.map((e) => (
              <div key={e.key} className="grid grid-cols-[54px_1fr] gap-2 border-t border-white/7 px-4 py-2">
                <span className="pt-0.5 font-mono text-[10.5px] text-ink-3">{new Date(e.ts).toLocaleTimeString([], { hour12: false })}</span>
                <div className="min-w-0">
                  <div className="font-mono text-[10.5px]" style={{ color: eventColor(e.type) }}>
                    {e.type}
                  </div>
                  <div className="truncate text-xs leading-[1.35] text-ink-2">{e.detail === e.type ? '' : e.detail}</div>
                </div>
              </div>
            ))
          ))}
        {tab === 'commands' &&
          (!session?.commands.length ? (
            <p className="px-4 py-3 text-xs text-ink-3">{room.runId ? 'No commands in this run yet.' : 'No live run.'}</p>
          ) : (
            session.commands.map((c) => (
              <div key={c.seq} className="grid grid-cols-[54px_1fr] gap-2 border-t border-white/7 px-4 py-2">
                <span className="pt-0.5 font-mono text-[10.5px] text-ink-3">{clockTime(c.ts)}</span>
                <div className="min-w-0">
                  <div className="truncate font-mono text-xs text-ink">{c.command}</div>
                  {c.exitCode !== undefined && <div className="font-mono text-[10.5px] text-ink-3">exit {c.exitCode}</div>}
                </div>
              </div>
            ))
          ))}
        {tab === 'files' &&
          (!session?.files.length ? (
            <p className="px-4 py-3 text-xs text-ink-3">{room.runId ? 'No files changed in this run yet.' : 'No live run.'}</p>
          ) : (
            session.files.map((f) => (
              <div key={f.path} className="flex gap-2 border-t border-white/7 px-4 py-2 font-mono text-xs">
                <span className="min-w-0 flex-1 truncate text-ink">{f.path}</span>
                {(f.adds !== undefined || f.dels !== undefined) && (
                  <span className="text-ink-3">
                    +{f.adds ?? 0} −{f.dels ?? 0}
                  </span>
                )}
              </div>
            ))
          ))}
      </div>
      <div className="flex gap-2 border-t border-white/10 px-4 py-3">
        <Link href="/sessions" className={buttonVariants({ variant: 'secondary', className: 'flex-1' })}>
          Open inspector
        </Link>
        <Link href="/conversations" className={buttonVariants({ className: 'flex-1' })}>
          Message
        </Link>
      </div>
    </Card>
  );
}
