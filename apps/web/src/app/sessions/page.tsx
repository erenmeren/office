'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useQueryClient } from '@tanstack/react-query';
import { ClaudeSessionDetail } from '@/components/claude-session-detail';
import { ClaudeSessionList } from '@/components/claude-session-list';
import { SessionDetail } from '@/components/session-detail';
import { SessionColumns, SessionList, type SessionFilter, type SessionSelection } from '@/components/session-list';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { DashboardStack } from '@/components/ui/kpi-card';
import { PageActions, PageDescription, PageHeader, PageTitle } from '@/components/ui/page-header';
import { useProject } from '@/lib/project';
import { useClaudeSessions, useLiveSessions, useProjects, type ClaudeSession } from '@/lib/queries';
import { useMounted } from '@/lib/use-mounted';

export default function SessionsPage() {
  const mounted = useMounted();
  const qc = useQueryClient();
  const project = useProject();
  const sessions = useLiveSessions(project?.id).data ?? [];
  const [filter, setFilter] = useState<SessionFilter>('all');
  const [picked, setPicked] = useState<SessionSelection | { claude: ClaudeSession }>();
  const projects = useProjects().data ?? [];
  const cli = useClaudeSessions();
  const cliError = cli.data?.unavailable === 'no_local_worker'
    ? 'No worker is connected from this machine, so its sessions cannot be read.'
    : cli.data?.unavailable || cli.error ? 'Could not read the sessions on this machine.' : undefined;
  const claude = picked && 'claude' in picked ? picked.claude : undefined;
  const selected = picked && 'runId' in picked ? picked : claude ? undefined : sessions[0] && { runId: sessions[0].runId };
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
            projects={projects}
            selectedProjectId={project?.id}
            selected={claude?.sessionId}
            onSelect={(s) => setPicked({ claude: s })}
            error={cliError}
          />
        </div>
        {claude ? (
          <ClaudeSessionDetail key={claude.sessionId} session={claude} />
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
