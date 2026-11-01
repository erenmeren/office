'use client';

import { useState } from 'react';
import { summarizeEvent, type OfficeEvent } from '@office/shared';
import { Badge } from '@/components/ui/badge';

export type LogRow = { kind: 'event'; event: OfficeEvent } | { kind: 'replay.done'; lastSeq: number };

// the shared summary falls back to the type name, which the row already shows as a badge
const summary = (e: OfficeEvent) => {
  const s = summarizeEvent(e);
  return s === e.type ? '' : s;
};

function Row({ event }: { event: OfficeEvent }) {
  const [open, setOpen] = useState(false);
  return (
    <li>
      <button
        className="grid w-full grid-cols-[64px_auto_minmax(0,1fr)] items-center gap-3 rounded-lg px-2 py-1.5 text-left hover:bg-white/6"
        onClick={() => setOpen(!open)}
      >
        <span className="font-mono text-xs text-ink-3" title={`seq ${event.seq}`}>
          {new Date(event.ts).toLocaleTimeString()}
        </span>
        <Badge variant="outline" className="font-mono text-ink-3">
          {event.type}
        </Badge>
        <span className="truncate text-sm text-ink-2">{summary(event)}</span>
      </button>
      {open && <pre className="overflow-x-auto rounded-lg bg-black/40 p-2 font-mono text-xs">{JSON.stringify(event.payload, null, 2)}</pre>}
    </li>
  );
}

export function EventLog({ rows }: { rows: LogRow[] }) {
  if (rows.length === 0) return <p className="text-sm text-muted-foreground">No events yet.</p>;
  return (
    <ul className="space-y-0.5">
      {rows.map((r) =>
        r.kind === 'event' ? (
          <Row key={r.event.seq} event={r.event} />
        ) : (
          <li key="replay-done" className="border-t border-dashed border-white/22" title={`replay done at seq ${r.lastSeq}`} />
        ),
      )}
    </ul>
  );
}
