'use client';

import { useEffect, useRef, useState } from 'react';
import type { OfficeEvent } from '@office/shared';
import { EventLog, type LogRow } from '@/components/event-log';
import { uiSocket } from '@/lib/ws';

/**
 * Live event log of one run: replays from seq 0, then streams; a divider marks where replay ended.
 * With `paused` set the log follows the tail in a scroll box under a "Following live · seq N" line;
 * pausing freezes what is shown while new events keep buffering, resuming shows them.
 */
export function RunEvents({ runId, onStatus, paused }: { runId: string; onStatus: (runId: string) => void; paused?: boolean }) {
  const [events, setEvents] = useState(new Map<number, OfficeEvent>());
  const [replayAt, setReplayAt] = useState<number>();
  let lastSeq = 0;
  for (const seq of events.keys()) lastSeq = Math.max(lastSeq, seq);
  // freeze at the seq shown when following was paused (state adjusted during render, not in an effect)
  const [frozen, setFrozen] = useState<{ paused?: boolean; at?: number }>({ paused });
  if (frozen.paused !== paused) setFrozen({ paused, at: paused ? lastSeq : undefined });
  const box = useRef<HTMLDivElement>(null);

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

  const shown = [...events.values()].filter((e) => frozen.at === undefined || e.seq <= frozen.at);
  const rows: LogRow[] = shown.sort((a, b) => a.seq - b.seq).map((event) => ({ kind: 'event', event }));
  if (replayAt !== undefined) {
    const at = rows.findIndex((r) => r.kind === 'event' && r.event.seq > replayAt);
    rows.splice(at === -1 ? rows.length : at, 0, { kind: 'replay.done', lastSeq: replayAt });
  }

  useEffect(() => {
    if (paused === false && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [paused, rows.length]);

  if (paused === undefined) return <EventLog rows={rows} />;
  const waiting = events.size - shown.length;
  return (
    <div className="flex flex-col gap-2">
      <p role="status" className="font-mono text-xs text-ink-3">
        {paused ? `Paused · seq ${(frozen.at ?? lastSeq).toLocaleString()}${waiting ? ` · ${waiting} new` : ''}` : `Following live · seq ${lastSeq.toLocaleString()}`}
      </p>
      <div ref={box} className="max-h-[520px] overflow-y-auto">
        <EventLog rows={rows} />
      </div>
    </div>
  );
}
