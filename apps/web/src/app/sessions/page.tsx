'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useQueryClient } from '@tanstack/react-query';
import { SessionDetail } from '@/components/session-detail';
import { SessionColumns, SessionList, type SessionFilter, type SessionSelection } from '@/components/session-list';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { DashboardStack } from '@/components/ui/kpi-card';
import { PageActions, PageDescription, PageHeader, PageTitle } from '@/components/ui/page-header';
import { useProject } from '@/lib/project';
import { useLiveSessions } from '@/lib/queries';
import { useMounted } from '@/lib/use-mounted';

export default function SessionsPage() {
  const mounted = useMounted();
  const qc = useQueryClient();
  const project = useProject();
  const sessions = useLiveSessions(project?.id).data ?? [];
  const [filter, setFilter] = useState<SessionFilter>('all');
  const [picked, setPicked] = useState<SessionSelection>();
  const selected = picked ?? (sessions[0] && { runId: sessions[0].runId });
  const recipients = [...new Map(sessions.map((s) => [s.agentId, { id: s.agentId, name: s.agentName }])).values()];

  if (!mounted) return null;

  return (
    <DashboardStack>
      <PageHeader>
        <div>
          <PageTitle>Live Sessions</PageTitle>
          <PageDescription>Every agent and subagent on its own: the commands it ran, the files it changed, and a way to talk to it.</PageDescription>
        </div>
        <PageActions>
          <Button variant="secondary" nativeButton={false} render={<Link href="/mission-control" />}>
            Open Mission Control
          </Button>
        </PageActions>
      </PageHeader>
      <SessionColumns>
        <SessionList sessions={sessions} filter={filter} onFilter={setFilter} selected={selected} onSelect={setPicked} />
        {selected && project ? (
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
