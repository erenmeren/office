'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { MessageThread } from '@/components/message-thread';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { PageActions, PageDescription, PageHeader, PageTitle } from '@/components/ui/page-header';
import { StatusPill } from '@/components/ui/status-pill';
import { Steps } from '@/components/ui/steps';
import { api } from '@/lib/api';
import { MISSION_STEPS, missionStatusLine, missionStep } from '@/lib/missions';
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

const EXAMPLES = ['Make a simple web page that shows my favourite recipes', 'Make a to-do list I can open in my browser', 'Make a birthday invitation page for my daughter'];

/**
 * The owner's conversation with the Conductor and the work it opened. `simple` is the newcomer's home page:
 * plain words, example requests and each piece of work as four steps.
 */
export function Assistant({ simple = false }: { simple?: boolean }) {
  const mounted = useMounted();
  const qc = useQueryClient();
  const router = useRouter();
  const [draft, setDraft] = useState<string>();
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
      // the assistant may have made a project for the request
      void qc.invalidateQueries({ queryKey: ['projects'] });
      void qc.invalidateQueries({ queryKey: ['conversation', conversationId] });
    };
    const offs = ['global', ...(conversationId ? [`conversation:${conversationId}`] : [])].map((t) => uiSocket().subscribe(t, 0, refresh));
    return () => offs.forEach((off) => off());
  }, [qc, conversationId]);

  if (!mounted) return null;
  const agent = view.data?.agent;
  const agents = agent ? [{ ...agent, currentVersion: null } as Agent] : [];
  const missions = view.data?.missions ?? [];
  // the simple view shows the talk between the owner and the assistant, not the notes the platform leaves it
  const shown = thread.data && simple ? { ...thread.data, messages: thread.data.messages.filter((m) => m.senderAgentId || m.senderUserId) } : thread.data;
  // Mission Control shows the selected project: switch to the mission's project first
  const open = (m: ConductorView['missions'][number]) => {
    selectProject(m.project.id);
    router.push(`/mission-control?mission=${m.id}`);
  };

  return (
    <div className="space-y-5">
      <PageHeader>
        <div>
          <PageTitle>{simple ? 'What would you like to get done?' : 'Conductor'}</PageTitle>
          <PageDescription>
            {simple
              ? 'Say it in your own words. The assistant hands the work to the team, keeps you posted here, and asks when it needs you.'
              : 'Tell the Conductor what you want, across all projects. It picks the project, opens a mission there for that project\u2019s Chief, and follows it. It never reads or changes code.'}
          </PageDescription>
        </div>
        {agent && !simple && (
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
              {simple && shown?.messages.length === 0 && (
                <div className="mb-4 flex flex-col items-start gap-2">
                  <p className="text-[13px] text-ink-3">Not sure how to start? Pick one and change it to your own:</p>
                  {EXAMPLES.map((example) => (
                    <Button key={example} variant="secondary" size="sm" onClick={() => setDraft(example)}>
                      {example}
                    </Button>
                  ))}
                </div>
              )}
              {shown ? (
                <MessageThread conversation={shown} agents={agents} ask draft={draft} placeholder={simple ? 'Describe what you want, as you would to a person.' : undefined} />
              ) : (
                <p className="text-sm text-ink-3">Loading…</p>
              )}
            </CardContent>
          </Card>
          <Card className="min-w-0 flex-[2_1_320px]">
            <CardHeader>
              <CardTitle>{simple ? 'Your work' : 'Missions it opened'}</CardTitle>
            </CardHeader>
            <CardContent>
              {missions.length === 0 ? (
                <p className="text-[13px] text-ink-3">{simple ? 'Nothing yet. What you ask for appears here, with where it stands.' : 'None yet. Each mission it opens appears here with its project and status.'}</p>
              ) : (
                <ul aria-label="Missions opened by the Conductor" className="flex flex-col divide-y divide-white/8">
                  {missions.map((m) => {
                    const line = missionStatusLine({ status: m.status, taskCounts: m.taskCounts });
                    const step = missionStep(m.status);
                    return (
                      <li key={m.id} className="flex flex-col gap-1 py-2.5">
                        <div className="flex items-center gap-2">
                          <button type="button" onClick={() => open(m)} className="min-w-0 flex-1 truncate text-left font-medium text-ink hover:underline">
                            {m.title}
                          </button>
                          <StatusPill status={m.status} />
                        </div>
                        <p className="text-[12.5px] text-ink-3">{m.project.name}</p>
                        {simple && step !== null && <Steps steps={MISSION_STEPS} current={step} aria-label={`Progress of ${m.title}`} className="my-1" />}
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
