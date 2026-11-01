'use client';

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { PlanGraph } from '@/components/plan-graph';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import { StatusDot, StatusPill } from '@/components/ui/status-pill';
import { Textarea } from '@/components/ui/textarea';
import { post, put } from '@/lib/api';
import { missionProgress, planGraphNodes } from '@/lib/missions';
import type { Agent, Mission } from '@/lib/queries';
import type { Tone } from '@/lib/status';

export const LEGEND: [Tone, string][] = [
  ['done', 'Done'],
  ['live', 'Running'],
  ['decision', 'Needs a decision'],
  ['idle', 'Queued'],
];

const CANCELLABLE = ['planning', 'plan_failed', 'awaiting_approval', 'approved', 'running', 'review'];
const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

function subtitle(m: Mission): string {
  if (m.status === 'planning') return 'Chief is writing the plan…';
  if (!m.plan) return '';
  const approval = m.approvals.findLast((a) => a.type === 'plan');
  const parts = [`Written by Chief ${time(approval?.createdAt ?? m.updatedAt)}`];
  if (approval?.status === 'approved' && approval.decidedAt) parts.push(`approved by you ${time(approval.decidedAt)}`);
  if (m.planErrors.length === 0) parts.push('dependency graph validated, no cycles');
  return parts.join(' · ');
}

export function PlanLegend() {
  return (
    <div className="flex flex-wrap gap-x-5 gap-y-2 text-[12.5px] text-ink-2">
      {LEGEND.map(([tone, label]) => (
        <span key={tone} className="inline-flex items-center gap-2">
          <StatusDot tone={tone} />
          {label}
        </span>
      ))}
    </div>
  );
}

/** The selected mission's plan: state, owner decisions, and its dependency graph. */
export function PlanCard({ mission: m, agents, selectedId, onSelect }: { mission: Mission; agents: Agent[]; selectedId?: string; onSelect: (id: string) => void }) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [draft, setDraft] = useState(() => (m.plan ? JSON.stringify(m.plan, null, 2) : ''));
  const progress = missionProgress(m.tasks);
  const pendingPlan = m.approvals.find((a) => a.type === 'plan' && a.status === 'pending');

  const act = (fn: () => Promise<unknown>) => async () => {
    setBusy(true);
    setError('');
    try {
      await fn();
      await Promise.all([qc.invalidateQueries({ queryKey: ['missions'] }), qc.invalidateQueries({ queryKey: ['approvals'] })]);
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };
  const savePlan = act(async () => {
    let plan: unknown;
    try {
      plan = JSON.parse(draft);
    } catch {
      throw new Error('The plan is not valid JSON.');
    }
    await put(`/missions/${m.id}/plan`, { plan });
  });

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center gap-3">
          <CardTitle>
            Plan v{m.planVersion} · {m.title}
          </CardTitle>
          <StatusPill status={m.status} />
        </div>
        <CardDescription>{subtitle(m)}</CardDescription>
        <CardAction className="flex min-w-[200px] items-center gap-3 self-center">
          <span className="font-mono text-[12.5px] whitespace-nowrap text-ink-2">
            {progress.done} of {progress.total} done
          </span>
          <Progress value={progress.pct} label="Plan progress" className="w-[140px]" />
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-4">
        {m.planErrors.length > 0 && (
          <ul className="list-disc space-y-1 pl-5 text-sm text-rose">
            {m.planErrors.map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
        )}
        {m.planRun?.error && <p className="text-sm whitespace-pre-wrap text-destructive">{m.planRun.error}</p>}
        <div className="flex flex-wrap items-center gap-2">
          {pendingPlan && (
            <>
              <Button disabled={busy} onClick={act(() => post(`/approvals/${pendingPlan.id}/approve`))}>
                Approve plan
              </Button>
              <Button variant="secondary" disabled={busy} onClick={act(() => post(`/approvals/${pendingPlan.id}/deny`))}>
                Reject
              </Button>
            </>
          )}
          {(m.status === 'plan_failed' || m.status === 'awaiting_approval') && (
            <Button variant="secondary" disabled={busy} onClick={act(() => post(`/missions/${m.id}/replan`))}>
              Replan
            </Button>
          )}
          {CANCELLABLE.includes(m.status) && (
            <Button variant="destructive" disabled={busy} onClick={act(() => post(`/missions/${m.id}/cancel`))}>
              Cancel mission
            </Button>
          )}
        </div>
        {m.status === 'awaiting_approval' && m.plan && (
          <div className="space-y-2">
            <Label htmlFor={`plan-json-${m.id}`} className="text-[12.5px] text-ink-2">
              Plan JSON
            </Label>
            <Textarea id={`plan-json-${m.id}`} rows={10} value={draft} onChange={(e) => setDraft(e.target.value)} className="font-mono text-[12.5px]" />
            <Button variant="secondary" disabled={busy} onClick={savePlan}>
              Save plan
            </Button>
          </div>
        )}
        {error && <p className="text-sm text-destructive">{error}</p>}
        {m.tasks.length > 0 && (
          <>
            <PlanLegend />
            <PlanGraph
              nodes={planGraphNodes(m, (id) => agents.find((a) => a.id === id)?.name)}
              selectedId={selectedId}
              onSelect={onSelect}
            />
          </>
        )}
      </CardContent>
    </Card>
  );
}
