'use client';

import Link from 'next/link';
import { useCallback, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowUpRight, Ban, CheckSquare, Database, FlaskConical, GitCompare, MessagesSquare, Square } from 'lucide-react';
import { canTransitionTask } from '@office/shared';
import { TaskContext } from '@/components/task-context';
import { RunEvents } from '@/components/run-events';
import { AgentAvatar } from '@/components/ui/agent-avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { EvidenceChip } from '@/components/ui/evidence-chip';
import { Kv, KvLabel, KvValue } from '@/components/ui/kv';
import { StatusPill } from '@/components/ui/status-pill';
import { post } from '@/lib/api';
import { useAgents, useArtifact, useMemory, useTask, useTasks, useWorkers, type Task, type TaskDetailView } from '@/lib/queries';

export const taskCode = (id: string) => id.slice(0, 8);

function TaskChips({ label, ids, tasks }: { label: string; ids: string[]; tasks: Task[] }) {
  if (ids.length === 0) return null;
  return (
    <Kv>
      <KvLabel>{label}</KvLabel>
      <KvValue>
        {ids.map((id) => {
          const dep = tasks.find((x) => x.id === id);
          return (
            <span key={id} className="inline-flex items-center gap-2 rounded-[10px] border border-white/13 bg-white/6 py-1 pr-1 pl-2.5">
              <span className="font-mono text-xs text-ink-2">{dep?.key ?? taskCode(id)}</span>
              {dep && <StatusPill status={dep.status} />}
            </span>
          );
        })}
      </KvValue>
    </Kv>
  );
}

/** A stored artifact's text (check output, mission review). */
export function ArtifactOutput({ artifactId }: { artifactId: string }) {
  const artifact = useArtifact(artifactId);
  if (artifact.isPending) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (artifact.isError) return <p className="text-sm text-destructive">{String(artifact.error)}</p>;
  return (
    <pre className="max-h-80 overflow-auto rounded-[10px] border border-white/13 bg-[rgb(7_5_24/0.55)] px-3.5 py-2.5 font-mono text-xs whitespace-pre-wrap text-ink-2">
      {artifact.data.content}
    </pre>
  );
}

/** Evidence the platform recorded for the task: git result, check output, memory written, its conversation. */
function Evidence({ t }: { t: TaskDetailView }) {
  const [open, setOpen] = useState<'diff' | 'tests'>();
  const memory = useMemory(t.projectId).data?.filter((e) => e.taskId === t.id).length ?? 0;
  const check = t.checkResult;
  const toggle = (k: 'diff' | 'tests') => setOpen((cur) => (cur === k ? undefined : k));
  return (
    <Kv>
      <KvLabel>Evidence</KvLabel>
      <div className="flex flex-wrap gap-2">
        {t.git && (
          // shortcut: the API stores no file or commit count, so the chip shows the commit range; add filesChanged to TaskRun to show `Diff <n> files`
          <EvidenceChip aria-expanded={open === 'diff'} onClick={() => toggle('diff')}>
            <GitCompare aria-hidden />
            Diff {t.git.baseCommit?.slice(0, 7) ?? '?'}..{t.git.headCommit.slice(0, 7)}
          </EvidenceChip>
        )}
        {check && (
          <EvidenceChip
            tone={check.status === 'passed' ? 'passed' : check.status === 'skipped' ? 'neutral' : 'failed'}
            aria-expanded={open === 'tests'}
            onClick={() => toggle('tests')}
          >
            <FlaskConical aria-hidden />
            Tests {check.status}
          </EvidenceChip>
        )}
        <EvidenceChip render={<Link href={`/memory?taskId=${t.id}`} />}>
          <Database aria-hidden />
          Memory {memory}
        </EvidenceChip>
        <EvidenceChip render={<Link href={`/conversations?taskId=${t.id}`} />}>
          <MessagesSquare aria-hidden />
          Conversation
        </EvidenceChip>
      </div>
      {open === 'diff' && t.git && (
        <div className="mt-2 grid gap-x-4 gap-y-3 rounded-[10px] border border-white/13 bg-white/5 p-3.5 [grid-template-columns:repeat(auto-fit,minmax(min(170px,100%),1fr))]">
          <Kv>
            <KvLabel>Branch</KvLabel>
            <KvValue className="font-mono">{t.git.branch ?? '—'}</KvValue>
          </Kv>
          <Kv>
            <KvLabel>Commits</KvLabel>
            <KvValue className="font-mono">
              {t.git.baseCommit?.slice(0, 7) ?? '?'} → {t.git.headCommit.slice(0, 7)}
            </KvValue>
          </Kv>
          <Kv>
            <KvLabel>Integration</KvLabel>
            <KvValue>
              <StatusPill status={t.git.integration} tone={t.git.integration === 'fast_forwarded' ? 'done' : t.git.integration === 'needs_integration' ? 'decision' : 'idle'} />
            </KvValue>
          </Kv>
        </div>
      )}
      {open === 'tests' && check && (
        <div className="mt-2 space-y-2">
          <p className="font-mono text-xs text-ink-3">
            $ {check.command}
            {check.exitCode !== null && ` · exit ${check.exitCode}`}
          </p>
          {check.artifactId ? <ArtifactOutput artifactId={check.artifactId} /> : <p className="text-sm text-muted-foreground">No output recorded.</p>}
        </div>
      )}
    </Kv>
  );
}

function Bullets({ label, items, checked }: { label: string; items: string[]; checked?: boolean }) {
  if (items.length === 0) return null;
  const Mark = checked ? CheckSquare : Square;
  return (
    <Kv>
      <KvLabel>{label}</KvLabel>
      <ul className="space-y-1.5 text-sm text-ink-2">
        {items.map((item, i) => (
          <li key={i} className="flex gap-2">
            {checked === undefined ? <span aria-hidden>•</span> : <Mark aria-label={checked ? 'Met' : 'Not yet checked'} className="mt-0.5 size-4 shrink-0" />}
            <span>{item}</span>
          </li>
        ))}
      </ul>
    </Kv>
  );
}

/** Selected task: the detail panel and its live feed, side by side. */
export function TaskDetail({ taskId }: { taskId: string }) {
  const qc = useQueryClient();
  const task = useTask(taskId);
  const agents = useAgents();
  const workers = useWorkers();
  const all = useTasks();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const refresh = useCallback(() => {
    void qc.invalidateQueries({ queryKey: ['task', taskId] });
    void qc.invalidateQueries({ queryKey: ['tasks'] });
    void qc.invalidateQueries({ queryKey: ['missions'] });
  }, [qc, taskId]);

  if (task.isPending) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (task.isError) return <p className="text-sm text-destructive">{String(task.error)}</p>;
  const t = task.data;
  const agent = agents.data?.find((a) => a.id === t.agentId);
  const latest = t.runs.at(-1);
  const worker = workers.data?.find((w) => w.id === latest?.workerId);
  const cost = t.runs.reduce((sum, r) => sum + r.costUsd, 0);
  const cap = (t.budgetUsd ?? agent?.currentVersion?.config.maxBudgetUsd) || undefined; // 0 = no cap
  const act = (path: string) => async () => {
    setBusy(true);
    setError('');
    try {
      await post(`/tasks/${t.id}/${path}`);
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
      refresh();
    }
  };

  return (
    <div className="flex flex-wrap gap-5">
      <Card className="min-w-0 flex-[3_1_560px]">
        <CardHeader>
          <div className="flex flex-wrap items-center gap-3">
            <Badge variant="outline" className="font-mono text-ink-2">
              {taskCode(t.id)}
            </Badge>
            <CardTitle className="font-heading text-xl leading-[26px]">{t.title}</CardTitle>
            <StatusPill status={t.status} />
          </div>
          <CardAction className="flex flex-wrap gap-2">
            {t.status === 'review' && (
              <>
                <Button size="lg" disabled={busy} onClick={act('done')}>
                  Mark done
                </Button>
                <Button variant="secondary" size="lg" disabled={busy} onClick={act('reopen')}>
                  Reopen
                </Button>
                <Button variant="destructive" size="lg" disabled={busy} onClick={act('failed')}>
                  Failed
                </Button>
              </>
            )}
            {t.status === 'failed' && (
              <Button variant="secondary" size="lg" disabled={busy} onClick={act('retry')}>
                Retry
              </Button>
            )}
            <Button variant="secondary" size="icon-lg" aria-label="Open task page" nativeButton={false} render={<Link href={`/tasks/${t.id}`} />}>
              <ArrowUpRight />
            </Button>
            {canTransitionTask(t.status, 'cancelled') && (
              <Button variant="destructive" size="icon-lg" aria-label="Cancel task" disabled={busy} onClick={act('cancel')}>
                <Ban />
              </Button>
            )}
          </CardAction>
        </CardHeader>
        <CardContent className="space-y-6">
          {error && <p className="text-sm text-destructive">{error}</p>}
          <div className="grid gap-x-4 gap-y-[18px] [grid-template-columns:repeat(auto-fit,minmax(min(170px,100%),1fr))]">
            <Kv>
              <KvLabel>Assigned to</KvLabel>
              <KvValue>
                {agent ? (
                  <>
                    <AgentAvatar name={agent.name} identity={agent.slug} size="sm" />
                    {agent.name}
                    {agent.currentVersion && <span className="font-mono text-xs text-ink-3">v{agent.currentVersion.version}</span>}
                  </>
                ) : (
                  <span className="font-mono">{t.agentId.slice(0, 8)}</span>
                )}
              </KvValue>
            </Kv>
            <Kv>
              <KvLabel>Worker</KvLabel>
              <KvValue>
                <span className="font-mono">{worker?.name ?? (latest?.workerId ? latest.workerId.slice(0, 8) : '—')}</span>
              </KvValue>
            </Kv>
            <Kv>
              <KvLabel>Retries</KvLabel>
              <KvValue>
                <span className="font-mono">
                  {t.attempts} of {t.maxAttempts}
                </span>
              </KvValue>
            </Kv>
            <Kv>
              <KvLabel>Budget</KvLabel>
              <KvValue>
                <span className="font-mono">${cost.toFixed(2)}</span>
                {cap !== undefined && (
                  <>
                    <span className="text-ink-2">of</span>
                    <span className="font-mono">${cap.toFixed(2)}</span>
                  </>
                )}
              </KvValue>
            </Kv>
          </div>
          {(t.dependencies.length > 0 || t.dependents.length > 0) && (
            <div className="flex flex-wrap gap-x-8 gap-y-3">
              <TaskChips label="Depends on" ids={t.dependencies} tasks={all.data ?? []} />
              <TaskChips label="Blocks" ids={t.dependents} tasks={all.data ?? []} />
            </div>
          )}
          <Bullets label="Requirements" items={t.requirements} />
          <Bullets label="Acceptance criteria" items={t.acceptanceCriteria} checked={t.status === 'done'} />
          {t.reviewNote && (
            <Kv>
              <KvLabel>Review note</KvLabel>
              <p className="max-w-prose text-sm whitespace-pre-wrap text-ink-2">{t.reviewNote}</p>
            </Kv>
          )}
          {t.missionId && <Evidence t={t} />}
          <TaskContext taskId={t.id} projectId={t.projectId} latest={latest} />
          {t.description && (
            <Kv>
              <KvLabel>Request</KvLabel>
              <p className="max-w-prose text-sm whitespace-pre-wrap text-ink-2">{t.description}</p>
            </Kv>
          )}
          {latest?.resultText && (
            <Kv>
              <KvLabel>Result</KvLabel>
              <p className="max-w-prose text-sm whitespace-pre-wrap text-ink-2">{latest.resultText}</p>
            </Kv>
          )}
          {latest?.error && <p className="text-sm whitespace-pre-wrap text-destructive">{latest.error}</p>}
        </CardContent>
      </Card>

      <Card className="min-w-0 flex-[2_1_360px]">
        <CardHeader>
          <CardTitle>Live feed · {taskCode(t.id)}</CardTitle>
          {latest && <CardDescription className="font-mono">run {latest.id.slice(0, 8)}</CardDescription>}
        </CardHeader>
        <CardContent>
          {/* the run's session exists only once a worker accepted it; polling picks it up */}
          {latest?.session ? (
            <RunEvents key={latest.id} runId={latest.id} onStatus={refresh} />
          ) : (
            <p className="text-sm text-muted-foreground">Waiting for a worker…</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
