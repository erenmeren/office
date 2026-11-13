'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { MessageThread } from '@/components/message-thread';
import { NewProjectForm } from '@/components/new-project-form';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { PageActions, PageDescription, PageHeader, PageTitle } from '@/components/ui/page-header';
import { StatusPill } from '@/components/ui/status-pill';
import { Steps } from '@/components/ui/steps';
import { ApiError, api } from '@/lib/api';
import { MISSION_STEPS, missionStatusLine, missionStep } from '@/lib/missions';
import { selectProject, useProject } from '@/lib/project';
import { useProjects, useTalks, type Agent, type Conversation, type MessageView, type MissionSummary } from '@/lib/queries';
import { closeTab, frontTab, openFresh, setTabs, useTabs } from '@/lib/tabs';
import { useMounted } from '@/lib/use-mounted';
import { uiSocket } from '@/lib/ws';

interface ConductorView {
  projectId: string;
  agent: Omit<Agent, 'currentVersion'> | null;
  /** the project the tab belongs to; a new tab has none yet */
  project: { id: string; slug: string; name: string } | null;
  conversation: Conversation | null;
  missions: (MissionSummary & { request: string; project: { id: string; slug: string; name: string }; pendingApprovals: string[] })[];
}

const REFRESH = ['message.created', 'mission.status.changed', 'task.status.changed', 'approval.changed'];

/** A button whose text may be longer than a narrow window: it wraps instead of running out of its card. */
const WRAP = 'h-auto min-h-7 max-w-full shrink justify-start py-1 text-left whitespace-normal';

const EXAMPLES = ['Make a simple web page that shows my favourite recipes', 'Make a to-do list I can open in my browser', 'Make a birthday invitation page for my daughter'];

/**
 * For a tab without a project: the projects whose tab was closed, the earlier talks that have no project (the one from
 * before the tabs among them), and the form for a folder Office does not know yet.
 */
function OpenProject() {
  const projects = useProjects().data ?? [];
  const { closed, fresh } = useTabs();
  const [creating, setCreating] = useState(false);
  const hidden = projects.filter((p) => closed.includes(p.id));
  const earlier = (useTalks().data ?? []).filter((t) => !fresh.includes(t.id));
  return (
    <Card className="min-w-0 flex-[2_1_320px]">
      <CardHeader>
        <CardTitle>Or open a project</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col items-start gap-2">
          {hidden.length > 0 && <p className="text-[13px] text-ink-3">Tabs you closed:</p>}
          {hidden.map((p) => (
            <Button key={p.id} variant="secondary" size="sm" className={WRAP} onClick={() => selectProject(p.id)}>
              {p.name}
            </Button>
          ))}
          {earlier.length > 0 && <p className="text-[13px] text-ink-3">Earlier talks:</p>}
          {earlier.map((t) => (
            <Button key={t.id} variant="secondary" size="sm" className={WRAP} onClick={() => setTabs((tabs) => openFresh(tabs, t.id))}>
              {t.title}
            </Button>
          ))}
          <p className="text-[13px] text-ink-3">A folder that is already on this computer:</p>
          <Button variant="secondary" size="sm" onClick={() => setCreating(true)}>
            Open an existing folder…
          </Button>
        </div>
        <Dialog open={creating} onOpenChange={setCreating}>
          <DialogContent>
            <DialogTitle>New project</DialogTitle>
            <NewProjectForm onDone={() => setCreating(false)} />
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  );
}

/**
 * The owner's conversation with the Conductor in the tab in front, and the work it opened there. Each project's tab has
 * a conversation of its own; a new tab has no project until the Conductor makes one for what is asked in it.
 * `simple` is the newcomer's home page: plain words, example requests and each piece of work as four steps.
 */
export function Assistant({ simple = false }: { simple?: boolean }) {
  const mounted = useMounted();
  const qc = useQueryClient();
  const router = useRouter();
  const [draft, setDraft] = useState<string>();
  const projects = useProjects();
  const front = frontTab(useTabs(), useProject());
  const fresh = front && 'fresh' in front ? front.fresh : undefined;
  const tab = front && ('fresh' in front ? `conversation=${front.fresh}` : `project=${front.project}`);
  const view = useQuery({ queryKey: ['conductor', tab], queryFn: () => api<ConductorView>(`/conductor?${tab}`), enabled: !!tab });
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

  // the assistant made a project for what was asked in this new tab: it is that project's tab from now on
  const made = fresh && view.data?.project?.id;
  // a new tab whose conversation is gone (the data was reset) is forgotten
  const gone = fresh && view.error instanceof ApiError && view.error.status === 404;
  useEffect(() => {
    if (!fresh || (!made && !gone)) return;
    setTabs((tabs) => closeTab(tabs, fresh));
    if (made) selectProject(made);
  }, [fresh, made, gone]);

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
              : 'Tell the Conductor what you want in the project of this tab. It opens a mission there for that project\u2019s Chief and follows it; in a new tab it makes the project first. It never reads or changes code.'}
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

      {!front && projects.isPending ? (
        // no tab yet only because the projects are still on their way
        <p className="text-sm text-ink-3">Loading…</p>
      ) : !front ? (
        <div className="flex flex-wrap gap-5">
          <Card className="min-w-0 flex-[3_1_480px]">
            <CardContent>
              <p className="text-sm text-ink-2">No tab is open. Open a new one with the + above the page, or pick a project.</p>
            </CardContent>
          </Card>
          <OpenProject />
        </div>
      ) : view.isPending ? (
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
              {simple && !view.data?.project && shown?.messages.length === 0 && (
                <div className="mb-4 flex flex-col items-start gap-2">
                  <p className="text-[13px] text-ink-3">Not sure how to start? Pick one and change it to your own:</p>
                  {EXAMPLES.map((example) => (
                    <Button key={example} variant="secondary" size="sm" className={WRAP} onClick={() => setDraft(example)}>
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
          {!view.data?.project ? (
            <OpenProject />
          ) : (
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
          )}
        </div>
      )}
    </div>
  );
}
