'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { MessageThread } from '@/components/message-thread';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { PageActions, PageDescription, PageHeader, PageTitle } from '@/components/ui/page-header';
import { StatusPill } from '@/components/ui/status-pill';
import { api } from '@/lib/api';
import { missionStatusLine } from '@/lib/missions';
import { selectProject } from '@/lib/project';
import type { Agent, Conversation, MessageView, MissionSummary } from '@/lib/queries';
import { useMounted } from '@/lib/use-mounted';
import { uiSocket } from '@/lib/ws';

interface ConductorView {
  projectId: string;
  agent: Omit<Agent, 'currentVersion'> | null;
  conversation: Conversation | null;
  missions: (MissionSummary & { request: string; project: { id: string; slug: string; name: string }; pendingApprovals: string[] })[];
}

const REFRESH = ['message.created', 'mission.status.changed', 'task.status.changed', 'approval.changed'];

export default function ConductorPage() {
  const mounted = useMounted();
  const qc = useQueryClient();
  const router = useRouter();
  const view = useQuery({ queryKey: ['conductor'], queryFn: () => api<ConductorView>('/conductor') });
  const conversationId = view.data?.conversation?.id;
  const thread = useQuery({
    queryKey: ['conversation', conversationId],
    queryFn: () => api<Conversation & { messages: MessageView[] }>(`/conversations/${conversationId}`),
    enabled: !!conversationId,
  });

  useEffect(() => {
    const refresh = (m: { type: string }) => {
      if (!REFRESH.includes(m.type)) return;
      void qc.invalidateQueries({ queryKey: ['conductor'] });
      void qc.invalidateQueries({ queryKey: ['conversation', conversationId] });
    };
    const offs = ['global', ...(conversationId ? [`conversation:${conversationId}`] : [])].map((t) => uiSocket().subscribe(t, 0, refresh));
    return () => offs.forEach((off) => off());
  }, [qc, conversationId]);

  if (!mounted) return null;
  const agent = view.data?.agent;
  const agents = agent ? [{ ...agent, currentVersion: null } as Agent] : [];
  const missions = view.data?.missions ?? [];
  // Mission Control shows the selected project: switch to the mission's project first
  const open = (m: ConductorView['missions'][number]) => {
    selectProject(m.project.id);
    router.push(`/mission-control?mission=${m.id}`);
  };

  return (
    <div className="space-y-5">
      <PageHeader>
        <div>
          <PageTitle>Conductor</PageTitle>
          <PageDescription>
            Tell the Conductor what you want, across all projects. It picks the project, opens a mission there for that project&apos;s Chief, and
            follows it. It never reads or changes code.
          </PageDescription>
        </div>
        {agent && (
          <PageActions>
            <Link href={`/agents/${agent.id}`} className="text-[13px] text-cyan hover:underline">
              Conductor settings
            </Link>
          </PageActions>
        )}
      </PageHeader>

      {view.isPending ? (
        <p className="text-sm text-ink-3">Loading…</p>
      ) : !agent ? (
        <Card>
          <CardContent>
            <p className="text-sm text-ink-2">
              The Conductor agent is not installed yet. Run <code className="font-mono">pnpm seed</code> once (the desktop app does this at start).
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="flex flex-wrap gap-5">
          <Card className="min-w-0 flex-[3_1_480px]">
            <CardContent>
              {thread.data ? <MessageThread conversation={thread.data} agents={agents} ask /> : <p className="text-sm text-ink-3">Loading…</p>}
            </CardContent>
          </Card>
          <Card className="min-w-0 flex-[2_1_320px]">
            <CardHeader>
              <CardTitle>Missions it opened</CardTitle>
            </CardHeader>
            <CardContent>
              {missions.length === 0 ? (
                <p className="text-[13px] text-ink-3">None yet. Each mission it opens appears here with its project and status.</p>
              ) : (
                <ul aria-label="Missions opened by the Conductor" className="flex flex-col divide-y divide-white/8">
                  {missions.map((m) => {
                    const line = missionStatusLine({ status: m.status, taskCounts: m.taskCounts });
                    return (
                      <li key={m.id} className="flex flex-col gap-1 py-2.5">
                        <div className="flex items-center gap-2">
                          <button type="button" onClick={() => open(m)} className="min-w-0 flex-1 truncate text-left font-medium text-ink hover:underline">
                            {m.title}
                          </button>
                          <StatusPill status={m.status} />
                        </div>
                        <p className="text-[12.5px] text-ink-3">{m.project.name}</p>
                        <p className={line.yours || m.pendingApprovals.length ? 'text-[12.5px] text-amber' : 'text-[12.5px] text-ink-2'}>
                          {line.text}
                          {m.pendingApprovals.length > 0 && (
                            <>
                              {' '}
                              <Link href="/decisions" onClick={() => selectProject(m.project.id)} className="underline">
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
        </div>
      )}
    </div>
  );
}
