'use client';

import { useParams } from 'next/navigation';
import { Fragment, useCallback, useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { canTransitionTask, type RunStatus } from '@office/shared';
import { RunEvents } from '@/components/run-events';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { post } from '@/lib/api';
import { useAgents, useRunSubagents, useTask } from '@/lib/queries';
import { uiSocket } from '@/lib/ws';

const ACTIVE_RUN: RunStatus[] = ['queued', 'running', 'waiting_reply', 'waiting_approval'];
const time = (s: string | null) => s && new Date(s).toLocaleTimeString();

function Subagents({ runId, active }: { runId: string; active: boolean }) {
  const subagents = useRunSubagents(runId, active);
  if (!subagents.data?.length) return <p className="text-sm text-muted-foreground">No subagents.</p>;
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Type</TableHead>
          <TableHead>Description</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Started</TableHead>
          <TableHead>Ended</TableHead>
          <TableHead>Summary</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {subagents.data.map((s) => (
          <TableRow key={s.id}>
            <TableCell className="font-mono">{s.subagentType}</TableCell>
            <TableCell className="whitespace-normal">{s.description}</TableCell>
            <TableCell>
              <Badge variant="outline">{s.status}</Badge>
            </TableCell>
            <TableCell>{time(s.startedAt)}</TableCell>
            <TableCell>{time(s.endedAt)}</TableCell>
            <TableCell className="whitespace-pre-wrap">{s.summary}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export default function TaskPage() {
  const { id } = useParams<{ id: string }>();
  const qc = useQueryClient();
  const task = useTask(id);
  const agents = useAgents();
  const refresh = useCallback(() => qc.invalidateQueries({ queryKey: ['task', id] }), [qc, id]);
  const onRunStatus = useCallback(
    (runId: string) => {
      void refresh();
      void qc.invalidateQueries({ queryKey: ['run-subagents', runId] });
    },
    [qc, refresh],
  );

  useEffect(
    () =>
      uiSocket().subscribe(`task:${id}`, 0, (m) => {
        if (m.type === 'task.status.changed') refresh();
      }),
    [id, refresh],
  );

  if (task.isPending) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (task.isError) return <p className="text-sm text-destructive">{String(task.error)}</p>;
  const t = task.data;
  const agent = agents.data?.find((a) => a.id === t.agentId);
  const latest = t.runs.at(-1);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold">{t.title}</h1>
        <Badge variant="secondary">{t.status}</Badge>
        <span className="text-sm text-muted-foreground">
          agent {agent?.name ?? t.agentId} · attempts {t.attempts}/{t.maxAttempts}
        </span>
        {canTransitionTask(t.status, 'cancelled') && (
          <Button variant="destructive" size="sm" className="ml-auto" onClick={() => post(`/tasks/${id}/cancel`).then(refresh)}>
            Cancel
          </Button>
        )}
      </div>
      {t.description && <p className="whitespace-pre-wrap text-sm">{t.description}</p>}

      <Card>
        <CardHeader>
          <CardTitle>Runs</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Run</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Started</TableHead>
                <TableHead>Finished</TableHead>
                <TableHead>Cost</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {t.runs.map((r) => (
                <Fragment key={r.id}>
                  <TableRow>
                    <TableCell className="font-mono">{r.id.slice(0, 8)}</TableCell>
                    <TableCell>
                      <Badge variant="outline">{r.status}</Badge>
                    </TableCell>
                    <TableCell>{time(r.startedAt)}</TableCell>
                    <TableCell>{time(r.finishedAt)}</TableCell>
                    <TableCell>${r.costUsd.toFixed(4)}</TableCell>
                  </TableRow>
                  {!!r.session?.skillsSnapshot?.length && (
                    <TableRow>
                      <TableCell colSpan={5} className="space-x-1">
                        {r.session.skillsSnapshot.map((s) => (
                          <Badge key={s.skillId} variant="secondary" className="font-mono">
                            {s.name}@{s.version} ({s.mode})
                          </Badge>
                        ))}
                      </TableCell>
                    </TableRow>
                  )}
                </Fragment>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {latest?.resultText && (
        <Card>
          <CardHeader>
            <CardTitle>Result</CardTitle>
          </CardHeader>
          <CardContent className="whitespace-pre-wrap text-sm">{latest.resultText}</CardContent>
        </Card>
      )}
      {latest?.error && <p className="whitespace-pre-wrap text-sm text-destructive">{latest.error}</p>}

      {latest && (
        <Card>
          <CardHeader>
            <CardTitle>Subagents (run {latest.id.slice(0, 8)})</CardTitle>
          </CardHeader>
          <CardContent>
            <Subagents runId={latest.id} active={ACTIVE_RUN.includes(latest.status)} />
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Events{latest && ` (run ${latest.id.slice(0, 8)})`}</CardTitle>
        </CardHeader>
        <CardContent>
          {/* the run's session exists only once a worker accepted it; polling picks it up */}
          {latest?.session ? (
            <RunEvents key={latest.id} runId={latest.id} onStatus={onRunStatus} />
          ) : (
            <p className="text-sm text-muted-foreground">Waiting for a worker…</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
