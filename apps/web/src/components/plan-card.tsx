'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { Activity, FileText, TerminalSquare } from 'lucide-react';
import { PlanGraph, type PlanGraphNode } from '@/components/plan-graph';
import { RunEvents } from '@/components/run-events';
import { ArtifactOutput } from '@/components/task-detail';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { EvidenceChip } from '@/components/ui/evidence-chip';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import { StatusDot, StatusPill } from '@/components/ui/status-pill';
import { Textarea } from '@/components/ui/textarea';
import { post, put } from '@/lib/api';
import { missionProgress, missionStatusLine, planGraphNodes, taskCounts } from '@/lib/missions';
import type { Agent, Mission } from '@/lib/queries';
import type { Tone } from '@/lib/status';
import { useConfirm } from '@/components/ui/confirm-dialog';

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

/** A titled dependency graph of tasks with the status legend. */
export function TaskGraphCard({ title, nodes, selectedId, onSelect }: { title: string; nodes: PlanGraphNode[]; selectedId?: string; onSelect: (id: string) => void }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <PlanLegend />
        <PlanGraph nodes={nodes} selectedId={selectedId} onSelect={onSelect} />
      </CardContent>
    </Card>
  );
}

const noop = () => {};

/** The Chief's verdict on a finished mission: its summary and the review run's events and mission-review.md. */
function MissionVerdict({ m }: { m: Mission }) {
  const [open, setOpen] = useState<'events' | 'review'>();
  const [handoffError, setHandoffError] = useState('');
  const router = useRouter();
  const toggle = (k: 'events' | 'review') => setOpen((cur) => (cur === k ? undefined : k));
  const finished = (m.status === 'done' || m.status === 'failed') && m.reviewRunId;
  const over = m.status === 'done' || m.status === 'failed' || m.status === 'cancelled';
  // handoff to the owner: a manual Claude session on the project's checkout, the mission's summary shown beside it
  const openManual = async () => {
    setHandoffError('');
    try {
      const t = await post<{ id: string }>('/terminals', { projectId: m.projectId });
      router.push(`/sessions?terminal=${t.id}&mission=${m.id}`);
    } catch (err) {
      setHandoffError(`Could not start a manual session: ${String(err)}`);
    }
  };
  if (!m.summary && !finished && !over) return null;
  return (
    <div className="space-y-2">
      {m.summary && <p className="text-sm whitespace-pre-wrap text-ink-2">{m.summary}</p>}
      {over && (
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="secondary" onClick={openManual} title="Your own Claude Code on this project, with the mission's summary to copy in. It works on the checkout, not the mission branch.">
            <TerminalSquare aria-hidden /> Open a manual session here
          </Button>
          {handoffError && <span className="text-sm text-destructive">{handoffError}</span>}
        </div>
      )}
      {finished && (
        <div className="flex flex-wrap gap-2">
          <EvidenceChip tone={m.status === 'done' ? 'passed' : 'failed'} aria-expanded={open === 'events'} onClick={() => toggle('events')}>
            <Activity aria-hidden />
            Review run events
          </EvidenceChip>
          {m.reviewArtifactId && (
            <EvidenceChip aria-expanded={open === 'review'} onClick={() => toggle('review')}>
              <FileText aria-hidden />
              mission-review.md
            </EvidenceChip>
          )}
        </div>
      )}
      {open === 'events' && m.reviewRunId && <RunEvents runId={m.reviewRunId} onStatus={noop} />}
      {open === 'review' && m.reviewArtifactId && <ArtifactOutput artifactId={m.reviewArtifactId} />}
    </div>
  );
}

/** The selected mission's plan: state, owner decisions, and its dependency graph. */
export function PlanCard({
  mission: m,
  agents,
  selectedId,
  onSelect,
  decisions = 0,
}: {
  mission: Mission;
  agents: Agent[];
  selectedId?: string;
  onSelect: (id: string) => void;
  /** tasks of this mission waiting for the owner's review decision */
  decisions?: number;
}) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [draft, setDraft] = useState(() => (m.plan ? JSON.stringify(m.plan, null, 2) : ''));
  const confirm = useConfirm();
  const progress = missionProgress(m.tasks);
  const pendingPlan = m.approvals.find((a) => a.type === 'plan' && a.status === 'pending');
  const line = missionStatusLine({ status: m.status, taskCounts: taskCounts(m.tasks), summary: m.summary, planError: m.planRun?.error, blocked: m.blocked, waitsFor: m.waitsFor, decisions });

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
          {m.conductorConversationId && (
            <Badge variant="outline" title="Opened by the Conductor">
              Conductor
            </Badge>
          )}
          <StatusPill status={m.status} />
        </div>
        <CardDescription>{subtitle(m)}</CardDescription>
        <p className={line.yours ? 'text-sm font-medium text-amber' : 'text-sm text-ink-2'} aria-live="polite">
          {line.text}
          {line.yours && m.status === 'review' && (
            <>
              {' '}
              <Link href="/decisions" className="underline">
                Open Decisions
              </Link>
            </>
          )}
        </p>
        <CardAction className="flex min-w-[200px] items-center gap-3 self-center">
          <span className="font-mono text-[12.5px] whitespace-nowrap text-ink-2">
            {progress.done} of {progress.total} done
          </span>
          <Progress value={progress.pct} label="Plan progress" className="w-[140px]" />
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-4">
        <MissionVerdict m={m} />
        {m.budgetUsd != null && m.spentUsd >= m.budgetUsd && (
          <p className="text-sm text-amber">
            Budget cap reached: ${m.spentUsd.toFixed(2)} of ${m.budgetUsd.toFixed(2)}. Tasks wait until the cap is raised.
          </p>
        )}
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
            <Button variant="destructive" disabled={busy} onClick={async () => (await confirm({ title: 'Cancel this mission?', body: 'Running tasks are stopped. Finished work stays on the mission branch.', confirmLabel: 'Cancel mission', destructive: true })) && act(() => post(`/missions/${m.id}/cancel`))()}>
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
