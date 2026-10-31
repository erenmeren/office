'use client';

import { useState } from 'react';
import type { OfficeEvent } from '@office/shared';
import { Badge } from '@/components/ui/badge';

export type LogRow = { kind: 'event'; event: OfficeEvent } | { kind: 'replay.done'; lastSeq: number };

function summary(e: OfficeEvent): string {
  const p = e.payload as {
    tool?: unknown;
    input?: { command?: unknown; path?: unknown };
    text?: unknown;
    skill?: unknown;
    subagentType?: unknown;
  };
  if (e.type === 'agent.skill.invoked') return `skill ${typeof p.skill === 'string' ? p.skill : ''}`.trim();
  if (e.type === 'agent.subagent.spawned') return `subagent ${typeof p.subagentType === 'string' ? p.subagentType : ''}`.trim();
  if (typeof p.tool === 'string') {
    const arg = p.input?.command ?? p.input?.path;
    return `${p.tool} ${typeof arg === 'string' ? arg.slice(0, 80) : ''}`;
  }
  if (typeof p.text === 'string') return p.text.slice(0, 120);
  return '';
}

function Row({ event }: { event: OfficeEvent }) {
  const [open, setOpen] = useState(false);
  return (
    <li>
      <button className="flex w-full gap-3 text-left hover:bg-muted/50" onClick={() => setOpen(!open)}>
        <span className="w-10 shrink-0 text-right text-muted-foreground">{event.seq}</span>
        <span className="shrink-0 text-muted-foreground">{new Date(event.ts).toLocaleTimeString()}</span>
        <Badge variant="outline" className="shrink-0 font-mono">
          {event.type}
        </Badge>
        <span className="truncate">{summary(event)}</span>
      </button>
      {open && <pre className="overflow-x-auto bg-muted/30 p-2 text-xs">{JSON.stringify(event.payload, null, 2)}</pre>}
    </li>
  );
}

export function EventLog({ rows }: { rows: LogRow[] }) {
  if (rows.length === 0) return <p className="text-sm text-muted-foreground">No events yet.</p>;
  return (
    <ul className="space-y-1 font-mono text-sm">
      {rows.map((r) =>
        r.kind === 'event' ? (
          <Row key={r.event.seq} event={r.event} />
        ) : (
          <li key="replay-done" className="border-t border-dashed" title={`replay done at seq ${r.lastSeq}`} />
        ),
      )}
    </ul>
  );
}
