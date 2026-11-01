'use client';

import { useEffect, useState } from 'react';
import type { OfficeEvent } from '@office/shared';
import { EventLog, type LogRow } from '@/components/event-log';
import { uiSocket } from '@/lib/ws';

/** Live event log of one run: replays from seq 0, then streams; a divider marks where replay ended. */
export function RunEvents({ runId, onStatus }: { runId: string; onStatus: (runId: string) => void }) {
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
          onStatus(runId);
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
