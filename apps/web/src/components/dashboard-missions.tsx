'use client';

import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { Card, CardAction, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { StatusPill } from '@/components/ui/status-pill';
import { missionStatusLine } from '@/lib/missions';
import { useProject } from '@/lib/project';
import { useMissions, useOverview } from '@/lib/queries';

const FINISHED = ['done', 'cancelled'];

/** Open missions with one sentence each on what they are doing and who they wait for. */
export function DashboardMissions() {
  const projectId = useProject()?.id;
  const missions = useMissions(projectId).data ?? [];
  const attention = useOverview(projectId).data?.attention ?? [];
  const open = missions.filter((m) => !FINISHED.includes(m.status)).slice(0, 6);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Missions</CardTitle>
        <CardAction>
          <Link href="/mission-control" className="text-[13px] text-cyan hover:underline">
            Mission Control
          </Link>
        </CardAction>
      </CardHeader>
      <CardContent>
        {open.length === 0 ? (
          <p className="text-[13px] text-ink-3">No open mission. Send a request from Mission Control.</p>
        ) : (
          <ul aria-label="Missions" className="flex flex-col divide-y divide-white/8">
            {open.map((m) => {
              const decisions = attention.filter((a) => a.kind === 'task_decision' && a.missionId === m.id).length;
              const line = missionStatusLine({ status: m.status, taskCounts: m.taskCounts, decisions });
              return (
                <li key={m.id} className="flex flex-col gap-1 py-2.5">
                  <div className="flex items-center gap-2">
                    <Link href={`/mission-control?mission=${m.id}`} className="min-w-0 flex-1 truncate font-medium text-ink hover:underline">
                      {m.title}
                    </Link>
                    {m.conductorConversationId && <Badge variant="outline">Conductor</Badge>}
                    <StatusPill status={m.status} />
                  </div>
                  <p className={line.yours ? 'text-[12.5px] text-amber' : 'text-[12.5px] text-ink-2'}>
                    {line.text}
                    {line.yours && (
                      <>
                        {' '}
                        <Link href="/decisions" className="underline">
                          Decide
                        </Link>
                      </>
                    )}
                  </p>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
