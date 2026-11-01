'use client';

import { useState } from 'react';
import { Pause, Play } from 'lucide-react';
import { PreviousTasksTable } from '@/components/previous-tasks-table';
import { RunEvents } from '@/components/run-events';
import { CommandTable, FileTable } from '@/components/session-detail';
import { subagentName } from '@/components/session-list';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Segmented } from '@/components/ui/segmented';
import { StatusPill } from '@/components/ui/status-pill';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useRunSubagents, type SessionDetail } from '@/lib/queries';
import { clockTime, commandRows, elapsed, isLive } from '@/lib/sessions';

type Tab = 'activity' | 'commands' | 'files' | 'subagents' | 'history';
const TABS: { value: Tab; label: string }[] = [
  { value: 'activity', label: 'Activity' },
  { value: 'commands', label: 'Commands' },
  { value: 'files', label: 'Files' },
  { value: 'subagents', label: 'Subagents' },
  { value: 'history', label: 'History' },
];

/** The session's events, commands, files, subagents and the agent's earlier tasks, one tab at a time. */
export function InspectorTabs({ detail: d, onStatus }: { detail: SessionDetail; onStatus: (runId: string) => void }) {
  const [tab, setTab] = useState<Tab>('activity');
  const [paused, setPaused] = useState(false);
  const live = isLive(d.status);

  return (
    <Card>
      <CardHeader>
        <Segmented label="Inspector sections" options={TABS} value={tab} onChange={setTab} />
      </CardHeader>
      {tab === 'activity' && (
        <>
          <CardHeader>
            <CardTitle>Agent activity</CardTitle>
            <CardDescription>Structured events from the Claude Agent SDK. Secrets are redacted before they are stored.</CardDescription>
            <CardAction>
              <Button variant="secondary" size="sm" aria-pressed={paused} onClick={() => setPaused(!paused)}>
                {paused ? <Play data-icon="inline-start" aria-hidden /> : <Pause data-icon="inline-start" aria-hidden />}
                {paused ? 'Resume following' : 'Pause following'}
              </Button>
            </CardAction>
          </CardHeader>
          <CardContent>
            <RunEvents runId={d.runId} onStatus={onStatus} paused={paused} />
          </CardContent>
        </>
      )}
      {tab === 'commands' && (
        <CardContent>
          {/* live events are not merged here; the session refetch brings new commands */}
          <CommandTable name={d.agentName} commands={commandRows(d.commands, [], live)} />
        </CardContent>
      )}
      {tab === 'files' && (
        <CardContent>
          <FileTable files={d.files} detail={d} />
        </CardContent>
      )}
      {tab === 'subagents' && (
        <CardContent>
          <SubagentTable runId={d.runId} live={live} />
        </CardContent>
      )}
      {tab === 'history' && (
        <CardContent>
          <PreviousTasksTable agentId={d.agentId} />
        </CardContent>
      )}
    </Card>
  );
}

function SubagentTable({ runId, live }: { runId: string; live: boolean }) {
  const q = useRunSubagents(runId, live);
  if (!q.data) return <p className="text-[13px] text-ink-3">{q.isError ? 'Could not load subagents.' : 'Loading…'}</p>;
  if (q.data.length === 0) return <p className="text-[13px] text-ink-3">No subagents in this session.</p>;
  return (
    <Table aria-label="Subagents">
      <TableHeader>
        <TableRow>
          <TableHead>Subagent</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Task</TableHead>
          <TableHead>Started</TableHead>
          <TableHead>Time</TableHead>
          <TableHead>Summary</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {q.data.map((s) => (
          <TableRow key={s.id}>
            <TableCell className="text-ink">{subagentName(s)}</TableCell>
            <TableCell><StatusPill status={s.status} /></TableCell>
            <TableCell className="max-w-[240px] truncate">{s.description ?? '—'}</TableCell>
            <TableCell className="font-mono text-xs text-ink-3">{clockTime(s.startedAt)}</TableCell>
            <TableCell className="font-mono text-xs">{s.endedAt ? elapsed(Date.parse(s.endedAt) - Date.parse(s.startedAt)) : '—'}</TableCell>
            <TableCell className="max-w-[280px] truncate text-ink-2" title={s.summary ?? undefined}>{s.summary ?? '—'}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
