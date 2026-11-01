'use client';

import { useEffect, useState } from 'react';
import { ActivityRow } from '@/components/ui/activity-row';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { activityFromEvent } from '@/lib/dashboard';
import { useActivity, useAgents, useProjects, type ActivityItem } from '@/lib/queries';
import { uiSocket } from '@/lib/ws';

const LIMIT = 50;

/** Stored events of the project, newest first, with live events prepended as they arrive. */
export function DashboardActivity() {
  const projectId = useProjects().data?.[0]?.id;
  const stored = useActivity(projectId).data;
  const agents = useAgents().data;
  const [live, setLive] = useState<ActivityItem[]>([]);

  useEffect(() => {
    if (!projectId) return;
    setLive([]);
    return uiSocket().subscribe(`project:${projectId}`, 0, (m) => {
      if (m.type !== 'event') return;
      const row = activityFromEvent(m.event, m.event.agentId);
      setLive((rows) => [row, ...rows].slice(0, LIMIT));
    });
  }, [projectId]);

  const name = (r: ActivityItem) => agents?.find((a) => a.id === r.agentId)?.name ?? r.agentName;
  const rows = [...live, ...(stored ?? [])].slice(0, LIMIT);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Recent activity</CardTitle>
        <CardDescription>Live from every session of this project.</CardDescription>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="text-[13px] text-ink-3">No session events yet.</p>
        ) : (
          <ol aria-label="Recent activity" className="flex max-h-[520px] flex-col divide-y divide-white/8 overflow-y-auto">
            {rows.map((r) => (
              <ActivityRow key={r.id} ts={r.ts} actor={name(r)} identity={agents?.find((a) => a.id === r.agentId)?.slug} type={r.type} detail={r.detail === r.type ? '' : r.detail} />
            ))}
          </ol>
        )}
      </CardContent>
    </Card>
  );
}
