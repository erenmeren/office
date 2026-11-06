'use client';

import { useEffect, useState } from 'react';
import { OfficeFloor } from '@/components/office-floor';
import { OfficeList, OfficeTimeline } from '@/components/office-views';
import { OfficeAgentPanel, OfficeApprovals, OfficeOwnerPanel } from '@/components/office-panel';
import { Card, CardContent } from '@/components/ui/card';
import { DashboardStack } from '@/components/ui/kpi-card';
import { PageActions, PageDescription, PageHeader, PageTitle } from '@/components/ui/page-header';
import { Segmented } from '@/components/ui/segmented';
import { mailFromMessage, officeRooms, ownerRoom, OWNER_ROOM, oneLine, waitingMail, type Mail } from '@/lib/office';
import { useProject } from '@/lib/project';
import { useActivity, useAgents, useClaudeSessions, useLiveSessions, useOverview, useTerminals, type Project } from '@/lib/queries';
import { statusTone } from '@/lib/status';
import { useMounted } from '@/lib/use-mounted';
import { uiSocket } from '@/lib/ws';

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

/**
 * What each room says and sends, live: the agent's latest `agent.text` or sent message as its bubble,
 * and an envelope per `message.created` between agents of this project.
 */
function useFloorLive(projectId: string) {
  const [said, setSaid] = useState<Record<string, string>>({});
  const [mail, setMail] = useState<Mail[]>([]);
  useEffect(() => {
    const unsubProject = uiSocket().subscribe(`project:${projectId}`, 0, (m) => {
      if (m.type !== 'event' || m.event.type !== 'agent.text') return;
      const text = (m.event.payload as { text?: unknown } | undefined)?.text;
      if (typeof text === 'string' && text.trim()) setSaid((s) => ({ ...s, [m.event.agentId]: oneLine(text) }));
    });
    const unsubGlobal = uiSocket().subscribe('global', 0, (m) => {
      if (m.type !== 'message.created') return;
      const now = Date.now();
      const flights = mailFromMessage(m.message, projectId, now);
      if (flights.length === 0) return;
      setSaid((s) => ({ ...s, [flights[0].from]: oneLine(m.message.body) }));
      setMail((list) => [...list.filter((x) => x.until > now), ...flights]);
    });
    return () => {
      unsubProject();
      unsubGlobal();
    };
  }, [projectId]);
  return { said, mail };
}

/** Pixel Office: the team as an isometric floor, one themed room per agent, live from the overview and sessions. */
export default function OfficePage() {
  const mounted = useMounted();
  const project = useProject();
  if (!mounted || !project) return null;
  // remounted per project so the live bubbles and envelopes of the previous one are dropped
  return <OfficeBody key={project.id} project={project} />;
}

function OfficeBody({ project }: { project: Project }) {
  const overview = useOverview(project.id).data;
  const activity = useActivity(project.id).data ?? [];
  const live = useFloorLive(project.id);
  const sessions = useLiveSessions(project.id).data ?? [];
  const agents = useAgents().data ?? [];
  const terminals = useTerminals().data ?? [];
  const claude = useClaudeSessions().data?.sessions ?? [];
  const now = useNow();
  const [picked, setPicked] = useState<string | null>(null);
  const [view, setView] = useState<'floor' | 'list' | 'timeline'>('floor');
  // the owner's own desk sits after the team: manual sessions in Office terminals and background sessions
  const rooms = [...officeRooms(overview?.team ?? [], sessions, agents), ownerRoom(terminals, claude, project.id)];
  const selected = rooms.find((r) => r.agentId === picked) ?? rooms.find((r) => r.status !== 'idle') ?? rooms[0];
  const count = (f: (status: string) => boolean) => rooms.filter((r) => f(r.status)).length;
  // bubble: what arrived live, else the waited question, else the last stored agent.text
  const bubbles = Object.fromEntries(
    rooms.map((r) => [r.agentId, live.said[r.agentId] ?? (r.waitingFor && oneLine(r.waitingFor.body)) ?? oneLine(activity.find((e) => e.agentId === r.agentId && e.type === 'agent.text')?.detail ?? '')]),
  );
  const mail = [...waitingMail(rooms), ...live.mail.filter((m) => m.until > now)];

  return (
    <DashboardStack>
      <PageHeader>
        <div>
          <PageTitle>Office</PageTitle>
          <PageDescription>
            Floor 1 · {rooms.length} rooms · <span className="text-mint">{count((s) => statusTone(s) === 'live')} running</span> ·{' '}
            <span className="text-amber">{count((s) => s === 'waiting_approval')} need approval</span> · {count((s) => s === 'waiting_reply')} waiting for reply ·{' '}
            {rooms.filter((r) => r.agentId !== OWNER_ROOM).reduce((n, r) => n + r.subs.length, 0)} subagents · {rooms.find((r) => r.agentId === OWNER_ROOM)?.subs.length ?? 0} yours
          </PageDescription>
        </div>
        <PageActions>
          <Segmented
            label="View"
            value={view}
            onChange={setView}
            options={[
              { value: 'floor', label: 'Floor' },
              { value: 'list', label: 'List' },
              { value: 'timeline', label: 'Timeline' },
            ]}
          />
          <span className="flex h-[34px] items-center gap-2 rounded-[10px] border border-mint/30 bg-mint/8 px-3 font-mono text-xs text-mint">
            <span className="size-2 rounded-full bg-mint" style={{ animation: 'om-live 1.6s ease-out infinite' }} />
            live · {new Date(now).toLocaleTimeString([], { hour12: false })}
          </span>
        </PageActions>
      </PageHeader>
      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
        {view === 'list' && <OfficeList rooms={rooms} selected={selected?.agentId ?? null} onSelect={setPicked} now={now} />}
        {view === 'timeline' && <OfficeTimeline key={project.id} projectId={project.id} rooms={rooms} selected={selected?.agentId ?? null} onSelect={setPicked} now={now} />}
        {view === 'floor' && <Card className="relative py-0">
          <div className="absolute top-3.5 left-4 z-[2] flex items-center gap-3.5 text-[11px] text-ink-3">
            {LEGEND.map(([color, label]) => (
              <span key={label} className="flex items-center gap-1.5">
                <i className="size-2 rounded-full" style={{ background: color }} />
                {label}
              </span>
            ))}
          </div>
          {rooms.length <= 1 && !overview?.team.length ? (
            <CardContent className="py-10 text-center text-[13px] text-ink-3">No agents on the team of this project yet.</CardContent>
          ) : (
            <OfficeFloor rooms={rooms} selected={selected?.agentId ?? null} onSelect={setPicked} now={now} mail={mail} bubbles={bubbles} />
          )}
        </Card>}
        <DashboardStack>
          <OfficeApprovals projectId={project.id} rooms={rooms} />
          {selected && selected.agentId === OWNER_ROOM ? (
            <OfficeOwnerPanel room={selected} terminals={terminals.filter((t) => t.projectId === project.id)} claude={claude.filter((s) => s.projectId === project.id)} now={now} />
          ) : (
            selected && <OfficeAgentPanel key={selected.agentId} room={selected} projectId={project.id} now={now} />
          )}
        </DashboardStack>
      </div>
    </DashboardStack>
  );
}
