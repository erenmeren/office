'use client';

import { useEffect, useState } from 'react';
import { OfficeFloor } from '@/components/office-floor';
import { OfficeAgentPanel, OfficeApprovals } from '@/components/office-panel';
import { Card, CardContent } from '@/components/ui/card';
import { DashboardStack } from '@/components/ui/kpi-card';
import { PageActions, PageDescription, PageHeader, PageTitle } from '@/components/ui/page-header';
import { officeRooms } from '@/lib/office';
import { useProject } from '@/lib/project';
import { useAgents, useLiveSessions, useOverview } from '@/lib/queries';
import { statusTone } from '@/lib/status';
import { useMounted } from '@/lib/use-mounted';

/** Wall clock, ticking once a second. */
function useNow() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return now;
}

const LEGEND: [string, string][] = [
  ['#3df5c8', 'running'],
  ['#ffc247', 'needs you'],
  ['#8d8ab3', 'idle'],
];

/** Pixel Office: the team as an isometric floor, one themed room per agent, live from the overview and sessions. */
export default function OfficePage() {
  const mounted = useMounted();
  const project = useProject();
  const overview = useOverview(project?.id).data;
  const sessions = useLiveSessions(project?.id).data ?? [];
  const agents = useAgents().data ?? [];
  const now = useNow();
  const [picked, setPicked] = useState<string | null>(null);
  const rooms = officeRooms(overview?.team ?? [], sessions, agents);
  const selected = rooms.find((r) => r.agentId === picked) ?? rooms.find((r) => r.status !== 'idle') ?? rooms[0];
  const count = (f: (status: string) => boolean) => rooms.filter((r) => f(r.status)).length;

  if (!mounted || !project) return null;

  return (
    <DashboardStack>
      <PageHeader>
        <div>
          <PageTitle>Office</PageTitle>
          <PageDescription>
            Floor 1 · {rooms.length} rooms · <span className="text-mint">{count((s) => statusTone(s) === 'live')} running</span> ·{' '}
            <span className="text-amber">{count((s) => s === 'waiting_approval')} need approval</span> · {count((s) => s === 'waiting_reply')} waiting for reply ·{' '}
            {rooms.reduce((n, r) => n + r.subs.length, 0)} subagents
          </PageDescription>
        </div>
        <PageActions>
          <span className="flex h-[34px] items-center gap-2 rounded-[10px] border border-mint/30 bg-mint/8 px-3 font-mono text-xs text-mint">
            <span className="size-2 rounded-full bg-mint" style={{ animation: 'om-live 1.6s ease-out infinite' }} />
            live · {new Date(now).toLocaleTimeString([], { hour12: false })}
          </span>
        </PageActions>
      </PageHeader>
      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
        <Card className="relative py-0">
          <div className="absolute top-3.5 left-4 z-[2] flex items-center gap-3.5 text-[11px] text-ink-3">
            {LEGEND.map(([color, label]) => (
              <span key={label} className="flex items-center gap-1.5">
                <i className="size-2 rounded-full" style={{ background: color }} />
                {label}
              </span>
            ))}
          </div>
          {rooms.length === 0 ? (
            <CardContent className="py-10 text-center text-[13px] text-ink-3">No agents on the team of this project yet.</CardContent>
          ) : (
            <OfficeFloor rooms={rooms} selected={selected?.agentId ?? null} onSelect={setPicked} now={now} />
          )}
        </Card>
        <DashboardStack>
          <OfficeApprovals projectId={project.id} rooms={rooms} />
          {selected && <OfficeAgentPanel key={selected.agentId} room={selected} projectId={project.id} now={now} />}
        </DashboardStack>
      </div>
    </DashboardStack>
  );
}
