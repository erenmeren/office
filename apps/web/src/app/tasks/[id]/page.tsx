'use client';

import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { canTransitionTask, type OfficeEvent } from '@office/shared';
import { EventLog, type LogRow } from '@/components/event-log';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { post } from '@/lib/api';
import { useAgents, useTask } from '@/lib/queries';
import { uiSocket } from '@/lib/ws';

function RunEvents({ runId, onStatus }: { runId: string; onStatus: () => void }) {
  const [events, setEvents] = useState(new Map<number, OfficeEvent>());
  const [replayAt, setReplayAt] = useState<number>();

  useEffect(
    () =>
      uiSocket().subscribe(`run:${runId}`, 0, (m) => {
        if (m.type === 'event') {
          setEvents((prev) => (prev.has(m.event.seq) ? prev : new Map(prev).set(m.event.seq, m.event)));
        } else if (m.type === 'replay.done') {
          setReplayAt((prev) => prev ?? m.lastSeq); // a reconnect replays again; keep the first divider
        } else if (m.type === 'run.status.changed') {
          onStatus();
        }
      }),
    [runId, onStatus],
  );

  const rows: LogRow[] = [...events.values()].sort((a, b) => a.seq - b.seq).map((event) => ({ kind: 'event', event }));
  if (replayAt !== undefined) {
    const at = rows.findIndex((r) => r.kind === 'event' && r.event.seq > replayAt);
    rows.splice(at === -1 ? rows.length : at, 0, { kind: 'replay.done', lastSeq: replayAt });
  }
  return <EventLog rows={rows} />;
}

export default function TaskPage() {
  const { id } = useParams<{ id: string }>();
  const qc = useQueryClient();
  const task = useTask(id);
  const agents = useAgents();
  const refresh = useCallback(() => qc.invalidateQueries({ queryKey: ['task', id] }), [qc, id]);

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
                <TableRow key={r.id}>
                  <TableCell className="font-mono">{r.id.slice(0, 8)}</TableCell>
                  <TableCell>
                    <Badge variant="outline">{r.status}</Badge>
                  </TableCell>
                  <TableCell>{r.startedAt && new Date(r.startedAt).toLocaleTimeString()}</TableCell>
                  <TableCell>{r.finishedAt && new Date(r.finishedAt).toLocaleTimeString()}</TableCell>
                  <TableCell>${r.costUsd.toFixed(4)}</TableCell>
                </TableRow>
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

      <Card>
        <CardHeader>
          <CardTitle>Events{latest && ` (run ${latest.id.slice(0, 8)})`}</CardTitle>
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
