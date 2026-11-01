'use client';

import { useCallback } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { InspectorHeader } from '@/components/inspector-header';
import { InspectorRail } from '@/components/inspector-rail';
import { InspectorTabs } from '@/components/inspector-tabs';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { DashboardColumns, DashboardStack } from '@/components/ui/kpi-card';
import { PageActions, PageDescription, PageHeader, PageTitle } from '@/components/ui/page-header';
import { useSession } from '@/lib/queries';
import { useMounted } from '@/lib/use-mounted';

export default function AgentInspectorPage() {
  const mounted = useMounted();
  const { runId } = useParams<{ runId: string }>();
  const qc = useQueryClient();
  const session = useSession(runId);
  const d = session.data;
  const refresh = useCallback(() => void qc.invalidateQueries({ queryKey: ['session', runId] }), [qc, runId]);

  if (!mounted) return null;

  return (
    <DashboardStack>
      <PageHeader>
        <div>
          <PageTitle>Agent Inspector</PageTitle>
          <PageDescription>One session in depth: its events, commands, files, subagents and skills.</PageDescription>
        </div>
        <PageActions>
          <Button variant="secondary" nativeButton={false} render={<Link href="/sessions" />}>
            All live sessions
          </Button>
        </PageActions>
      </PageHeader>
      {d ? (
        <DashboardColumns>
          <DashboardStack>
            <InspectorHeader detail={d} onCancelled={refresh} />
            <InspectorTabs detail={d} onStatus={refresh} />
          </DashboardStack>
          <InspectorRail detail={d} />
        </DashboardColumns>
      ) : (
        <Card>
          <CardContent>{session.isError ? 'Could not load this session.' : 'Loading…'}</CardContent>
        </Card>
      )}
    </DashboardStack>
  );
}
