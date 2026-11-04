'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { post } from '@/lib/api';
import { relativeTime } from '@/lib/workers';
import { useProject } from '@/lib/project';
import { useOverview, type Overview } from '@/lib/queries';

type Item = Overview['attention'][number];

function ApprovalActions({ id }: { id: string }) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const decide = async (path: 'approve' | 'deny') => {
    setBusy(true);
    setError('');
    try {
      await post(`/approvals/${id}/${path}`, path === 'approve' ? { scope: 'once' } : undefined);
    } catch (err) {
      // e.g. 409 already_decided: the refetch below drops the stale row
      setError(String(err));
    } finally {
      setBusy(false);
      await Promise.all([qc.invalidateQueries({ queryKey: ['overview'] }), qc.invalidateQueries({ queryKey: ['approvals'] })]);
    }
  };
  return (
    <div className="flex shrink-0 flex-col items-end gap-1">
      <div className="flex gap-2">
        <Button size="sm" disabled={busy} onClick={() => decide('approve')}>
          Approve
        </Button>
        <Button size="sm" variant="destructive" disabled={busy} onClick={() => decide('deny')}>
          Deny
        </Button>
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}

function AttentionRow({ item }: { item: Item }) {
  const approval = item.kind === 'approval';
  return (
    <li className="flex items-start gap-3 rounded-[14px] border border-amber/30 bg-amber/6 p-3">
      <div className="min-w-0 flex-1">
        <div className="font-medium text-ink">
          {approval ? `Approve ${item.title}` : item.kind === 'task_decision' ? `Decide task: ${item.title}` : `Review skill import: ${item.title}`}
        </div>
        <p className="mt-0.5 line-clamp-2 text-[12.5px] text-ink-2">{item.detail}</p>
        <p className="mt-1 text-xs text-ink-3">
          {approval ? 'Approval' : item.kind === 'task_decision' ? 'Mission review' : 'Skill Library'} · {relativeTime(item.createdAt)}
        </p>
      </div>
      {approval ? (
        <ApprovalActions id={item.id} />
      ) : item.kind === 'task_decision' ? (
        <Link href={`/tasks/${item.id}`} className={buttonVariants({ size: 'sm', variant: 'secondary' })}>
          Decide
        </Link>
      ) : (
        <Link href={`/skills/${item.id}`} className={buttonVariants({ size: 'sm', variant: 'secondary' })}>
          Review import
        </Link>
      )}
    </li>
  );
}

/** Pending approvals, skill imports and review-blocked tasks waiting for the owner. */
export function DashboardAttention() {
  const items = useOverview(useProject()?.id).data?.attention ?? [];
  return (
    <Card>
      <CardHeader>
        <CardTitle>Needs your attention</CardTitle>
        <CardAction>
          <span className="grid h-5 min-w-5 place-items-center rounded-full bg-amber/20 px-1.5 font-mono text-xs font-semibold text-amber">{items.length}</span>
        </CardAction>
      </CardHeader>
      <CardContent>
        {items.length === 0 ? (
          <p className="text-[13px] text-ink-3">Nothing is waiting for you.</p>
        ) : (
          <ul aria-label="Needs your attention" className="flex flex-col gap-2">
            {items.map((i) => (
              <AttentionRow key={`${i.kind}:${i.id}`} item={i} />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
