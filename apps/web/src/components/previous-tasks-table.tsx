'use client';

import Link from 'next/link';
import { StatusPill } from '@/components/ui/status-pill';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { usd } from '@/lib/dashboard';
import { useAgentRuns } from '@/lib/queries';
import { elapsed } from '@/lib/sessions';

/** The agent's earlier task runs, newest first, each linking to its own inspector. */
export function PreviousTasksTable({ agentId }: { agentId: string }) {
  const q = useAgentRuns(agentId);
  if (!q.data) return <p className="text-[13px] text-ink-3">{q.isError ? 'Could not load previous tasks.' : 'Loading…'}</p>;
  if (q.data.length === 0) return <p className="text-[13px] text-ink-3">No previous tasks.</p>;
  return (
    <Table aria-label="Previous tasks">
      <TableHeader>
        <TableRow>
          <TableHead>Task</TableHead>
          <TableHead>Title</TableHead>
          <TableHead>Result</TableHead>
          <TableHead>Time</TableHead>
          <TableHead>Cost</TableHead>
          <TableHead>Commit</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {q.data.map((r) => (
          <TableRow key={r.runId}>
            <TableCell className="font-mono text-xs">
              <Link href={`/sessions/${r.runId}`} className="text-cyan hover:underline">
                {r.taskKey ?? r.runId.slice(0, 8)}
              </Link>
            </TableCell>
            <TableCell className="max-w-[280px] truncate text-ink">{r.taskTitle ?? '—'}</TableCell>
            <TableCell><StatusPill status={r.status} /></TableCell>
            <TableCell className="font-mono text-xs">{r.durationMs === null ? '—' : elapsed(r.durationMs)}</TableCell>
            <TableCell className="font-mono text-xs">{usd(r.costUsd)}</TableCell>
            <TableCell className="font-mono text-xs text-ink-3">{r.headCommit ? r.headCommit.slice(0, 7) : 'no commit'}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
