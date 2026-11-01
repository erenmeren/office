'use client';

import Link from 'next/link';
import { useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowUpRight, Ban } from 'lucide-react';
import { canTransitionTask } from '@office/shared';
import { RunEvents } from '@/components/run-events';
import { AgentAvatar } from '@/components/ui/agent-avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Kv, KvLabel, KvValue } from '@/components/ui/kv';
import { StatusPill } from '@/components/ui/status-pill';
import { post } from '@/lib/api';
import { useAgents, useTask, useWorkers } from '@/lib/queries';

export const taskCode = (id: string) => id.slice(0, 8);

/** Selected task: the detail panel and its live feed, side by side. */
export function TaskDetail({ taskId }: { taskId: string }) {
  const qc = useQueryClient();
  const task = useTask(taskId);
  const agents = useAgents();
  const workers = useWorkers();
  const refresh = useCallback(() => {
    void qc.invalidateQueries({ queryKey: ['task', taskId] });
    void qc.invalidateQueries({ queryKey: ['tasks'] });
  }, [qc, taskId]);

  if (task.isPending) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (task.isError) return <p className="text-sm text-destructive">{String(task.error)}</p>;
  const t = task.data;
  const agent = agents.data?.find((a) => a.id === t.agentId);
  const latest = t.runs.at(-1);
  const worker = workers.data?.find((w) => w.id === latest?.workerId);
  const cost = t.runs.reduce((sum, r) => sum + r.costUsd, 0);
  const cap = agent?.currentVersion?.config.maxBudgetUsd;

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
          <CardAction className="flex gap-2">
            <Button variant="secondary" size="icon-lg" aria-label="Open task page" nativeButton={false} render={<Link href={`/tasks/${t.id}`} />}>
              <ArrowUpRight />
            </Button>
            {canTransitionTask(t.status, 'cancelled') && (
              <Button variant="destructive" size="icon-lg" aria-label="Cancel task" onClick={() => post(`/tasks/${t.id}/cancel`).then(refresh)}>
                <Ban />
              </Button>
            )}
          </CardAction>
        </CardHeader>
        <CardContent className="space-y-6">
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
              <KvLabel>Attempts</KvLabel>
              <KvValue>
                <span className="font-mono">
                  {t.attempts} of {t.maxAttempts}
                </span>
                <span className="text-ink-2">used</span>
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
