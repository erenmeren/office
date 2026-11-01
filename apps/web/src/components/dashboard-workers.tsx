'use client';

import Link from 'next/link';
import { Card, CardAction, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { StatusPill } from '@/components/ui/status-pill';
import { useWorkers } from '@/lib/queries';
import { relativeTime } from '@/lib/workers';

/** Each worker's mode, state, slot use and heartbeat age. */
export function DashboardWorkers() {
  const workers = useWorkers().data ?? [];
  return (
    <Card>
      <CardHeader>
        <CardTitle>Workers</CardTitle>
        <CardAction>
          <Link href="/workers" className="text-[13px] text-cyan hover:underline">
            Manage
          </Link>
        </CardAction>
      </CardHeader>
      <CardContent>
        {workers.length === 0 ? (
          <p className="text-[13px] text-ink-3">No workers enrolled.</p>
        ) : (
          <ul aria-label="Workers" className="flex flex-col divide-y divide-white/8">
            {workers.map((w) => (
              <li key={w.id} className="flex items-center gap-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-medium text-ink">{w.name}</span>
                    {w.status !== 'pending' && (
                      <span className="rounded-full border border-white/13 px-2 text-[11px] text-ink-2">{w.canClone ? 'remote' : 'local'}</span>
                    )}
                  </div>
                  <div className="text-xs text-ink-3">{w.lastHeartbeatAt ? `Heartbeat ${relativeTime(w.lastHeartbeatAt)}` : 'No heartbeat yet'}</div>
                </div>
                <span className="font-mono text-[13px] text-ink-2" title="Runs in use / slots">
                  {w.activeRuns}/{w.capacity}
                </span>
                <StatusPill status={w.status} />
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
