'use client';

import { Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { ClaudeSessionDetail } from '@/components/claude-session-detail';
import { ClaudeSessionList } from '@/components/claude-session-list';
import { SessionDetail } from '@/components/session-detail';
import { TerminalDetail } from '@/components/terminal-detail';
import { SessionColumns, SessionList, type SessionFilter, type SessionSelection } from '@/components/session-list';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { DashboardStack } from '@/components/ui/kpi-card';
import { PageActions, PageDescription, PageHeader, PageTitle } from '@/components/ui/page-header';
import { useProject } from '@/lib/project';
import { post } from '@/lib/api';
import { useClaudeSessions, useLiveSessions, useMission, useProjects, useTerminals, type TerminalView } from '@/lib/queries';
import { uiSocket } from '@/lib/ws';
import { useMounted } from '@/lib/use-mounted';

function SessionsPageInner() {
  const mounted = useMounted();
  const qc = useQueryClient();
  const project = useProject();
  const sessions = useLiveSessions(project?.id).data ?? [];
  const [filter, setFilter] = useState<SessionFilter>('all');
  const [picked, setPicked] = useState<SessionSelection | { claude: string } | { terminal: string }>();
  const [terminalError, setTerminalError] = useState('');
  const terminals = useTerminals();
  const params = useSearchParams();
  const projects = useProjects().data ?? [];
  const cli = useClaudeSessions();
  const cliError = cli.data?.unavailable === 'no_local_worker'
    ? 'No worker is connected from this machine, so its sessions cannot be read.'
    : cli.data?.unavailable || cli.error ? 'Could not read the sessions on this machine.' : undefined;
  useEffect(
    () =>
      uiSocket().subscribe('global', 0, (m) => {
        if (m.type === 'terminal.changed') void qc.invalidateQueries({ queryKey: ['terminals'] });
      }),
    [qc],
  );
  const terminalList = [...(terminals.data ?? [])].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  // deep links until the owner picks something: ?terminal=<id> (a manual session) or ?session=<claude session id>
  const wantTerminal = params.get('terminal');
  const wantSession = params.get('session');
  // ?mission=<id> with ?terminal=: the finished mission this manual session continues (its summary shown beside the terminal)
  const handoffMission = useMission(params.get('mission') ?? undefined).data;
  const linked = picked ? undefined : wantTerminal && terminalList.some((t) => t.id === wantTerminal) ? { terminal: wantTerminal } : wantSession ? { claude: wantSession } : undefined;
  const current = picked ?? linked;
  const terminal = current && 'terminal' in current ? terminalList.find((t) => t.id === current.terminal) : undefined;
  const showTerminal = (t: TerminalView) => {
    qc.setQueryData<TerminalView[]>(['terminals'], (prev) => (prev?.some((x) => x.id === t.id) ? prev : [...(prev ?? []), t]));
    setPicked({ terminal: t.id });
  };
  const newBackground = async (prompt: string) => {
    await post('/claude-sessions/background', { projectId: project!.id, prompt });
    await qc.invalidateQueries({ queryKey: ['claude-sessions'] });
  };
  const newTerminal = async () => {
    setTerminalError('');
    try {
      showTerminal(await post<TerminalView>('/terminals', { projectId: project!.id }));
    } catch (err) {
      setTerminalError(`Could not start a manual session: ${String(err)}`);
    }
  };
  // the session row itself comes from the latest list, so a stop or a finished run updates the open detail
  const claude = current && 'claude' in current ? cli.data?.sessions.find((x) => x.sessionId === current.claude) : undefined;
  const selected = current && 'runId' in current ? current : claude || terminal ? undefined : sessions[0] && { runId: sessions[0].runId };
  const recipients = [...new Map(sessions.map((s) => [s.agentId, { id: s.agentId, name: s.agentName }])).values()];

  if (!mounted) return null;

  return (
    <DashboardStack>
      <PageHeader>
        <div>
          <PageTitle>Live Sessions</PageTitle>
          <PageDescription>Every agent and subagent on its own: the commands it ran, the files it changed, and a way to talk to it. Below them, the Claude Code sessions you started yourself.</PageDescription>
        </div>
        <PageActions>
          <Button variant="secondary" nativeButton={false} render={<Link href="/mission-control" />}>
            Open Mission Control
          </Button>
        </PageActions>
      </PageHeader>
      <SessionColumns>
        <div className="flex flex-col gap-4">
          <SessionList sessions={sessions} filter={filter} onFilter={setFilter} selected={selected} onSelect={setPicked} />
          <ClaudeSessionList
            sessions={cli.data?.sessions ?? []}
            terminals={terminalList}
            projects={projects}
            selectedProjectId={project?.id}
            selected={claude?.sessionId ?? terminal?.id}
            onSelect={(s) => setPicked({ claude: s.sessionId })}
            onSelectTerminal={(t) => setPicked({ terminal: t.id })}
            onNewTerminal={project ? newTerminal : undefined}
            onNewBackground={project ? newBackground : undefined}
            error={cliError ?? (terminalError || undefined)}
          />
        </div>
        {terminal ? (
          <TerminalDetail key={terminal.id} terminal={terminal} onGone={() => setPicked(undefined)} mission={wantTerminal === terminal.id ? handoffMission : undefined} />
        ) : claude ? (
          <ClaudeSessionDetail key={claude.sessionId} session={claude} onResumed={showTerminal} onDeleted={() => setPicked(undefined)} />
        ) : selected && project ? (
          <SessionDetail
            key={selected.runId}
            runId={selected.runId}
            subagentId={selected.subagentId}
            projectId={project.id}
            recipients={recipients}
            onCancelled={() => void qc.invalidateQueries({ queryKey: ['session'] }).then(() => qc.invalidateQueries({ queryKey: ['sessions'] }))}
          />
        ) : (
          <Card>
            <CardContent>Pick a session to see its commands and files.</CardContent>
          </Card>
        )}
      </SessionColumns>
    </DashboardStack>
  );
}

export default function SessionsPage() {
  return (
    <Suspense>
      <SessionsPageInner />
    </Suspense>
  );
}
