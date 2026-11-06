'use client';

import { useLiveActivity } from '@/components/dashboard-activity';
import { AgentAvatar } from '@/components/ui/agent-avatar';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { StatusPill } from '@/components/ui/status-pill';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { timelineLanes, type OfficeRoom } from '@/lib/office';
import { elapsed } from '@/lib/sessions';
import { cn } from 'cn';

interface ViewProps {
  rooms: OfficeRoom[];
  selected: string | null;
  onSelect: (agentId: string) => void;
  now: number;
}

/** The floor as a table: one row per room. */
export function OfficeList({ rooms, selected, onSelect, now }: ViewProps) {
  return (
    <Card>
      <CardContent>
        <Table aria-label="Team">
          <TableHeader>
            <TableRow>
              <TableHead>Agent</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Working on</TableHead>
              <TableHead>Worker</TableHead>
              <TableHead>Subagents</TableHead>
              <TableHead>Elapsed</TableHead>
              <TableHead className="text-right">Cost</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rooms.map((r) => (
              <TableRow key={r.agentId} data-state={r.agentId === selected ? 'selected' : undefined}>
                <TableCell>
                  <button type="button" onClick={() => onSelect(r.agentId)} className="flex items-center gap-2 text-ink hover:underline">
                    <AgentAvatar name={r.name} identity={r.slug} size="sm" />
                    {r.name}
                  </button>
                </TableCell>
                <TableCell><StatusPill status={r.status} /></TableCell>
                <TableCell className="max-w-[260px] truncate text-ink-2">{r.task || '—'}</TableCell>
                <TableCell className="font-mono text-xs">{r.workerName ?? '—'}</TableCell>
                <TableCell className="font-mono text-xs">{r.subs.filter((s) => !s.done).length}/{r.subs.length}</TableCell>
                <TableCell className="font-mono text-xs">{r.startedAt ? elapsed(now - Date.parse(r.startedAt)) : '—'}</TableCell>
                <TableCell className="text-right font-mono text-xs">${r.costUsd.toFixed(2)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

const TIMELINE_EVENTS = 200;

/** One lane per room with the stored and live events of the project on a shared time axis. */
export function OfficeTimeline({ projectId, rooms, selected, onSelect, now }: ViewProps & { projectId: string }) {
  const { rows } = useLiveActivity(projectId, TIMELINE_EVENTS);
  const { start, lanes } = timelineLanes(rooms, rows, now);
  const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour12: false });
  return (
    <Card>
      <CardHeader>
        <CardTitle>Timeline</CardTitle>
        <CardDescription>The latest {TIMELINE_EVENTS} events of this project. Hover a mark for its detail.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        <div className="flex justify-between pl-[150px] font-mono text-[11px] text-ink-3">
          <span>{clock(start)}</span>
          <span>{clock(now)}</span>
        </div>
        {rooms.map((room) => (
          <div key={room.agentId} className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => onSelect(room.agentId)}
              className={cn('w-[138px] shrink-0 truncate text-left text-[13px] hover:underline', room.agentId === selected ? 'text-ink' : 'text-ink-2')}
            >
              {room.name}
            </button>
            <ol aria-label={`${room.name} events`} className="relative h-6 min-w-0 flex-1 rounded-md bg-white/4">
              {lanes.find((l) => l.agentId === room.agentId)?.events.map(({ event, at }) => (
                <li
                  key={event.key}
                  title={`${clock(Date.parse(event.ts))} ${event.type}${event.detail ? `: ${event.detail}` : ''}`}
                  className="absolute top-1 h-4 w-[3px] rounded-full bg-cyan/70"
                  style={{ left: `${at * 100}%` }}
                />
              ))}
            </ol>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
