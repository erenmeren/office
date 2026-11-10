'use client';

import Link from 'next/link';
import { Assistant } from '@/components/assistant';
import { DashboardActivity } from '@/components/dashboard-activity';
import { DashboardAttention } from '@/components/dashboard-attention';
import { DashboardCosts } from '@/components/dashboard-costs';
import { DashboardKpis } from '@/components/dashboard-kpis';
import { DashboardMissions } from '@/components/dashboard-missions';
import { DashboardTeam } from '@/components/dashboard-team';
import { DashboardWorkers } from '@/components/dashboard-workers';
import { Button } from '@/components/ui/button';
import { DashboardColumns, DashboardStack } from '@/components/ui/kpi-card';
import { PageActions, PageDescription, PageHeader, PageTitle } from '@/components/ui/page-header';
import { useSimpleMode } from '@/lib/simple-mode';

/** The home page: the assistant in the simple view, the dashboard otherwise. */
export default function Home() {
  return useSimpleMode() ? <Assistant simple /> : <Dashboard />;
}

function Dashboard() {
  return (
    <DashboardStack>
      <PageHeader>
        <div>
          <PageTitle>Dashboard</PageTitle>
          <PageDescription>What the team is doing right now, across every project.</PageDescription>
        </div>
        <PageActions>
          <Button nativeButton={false} render={<Link href="/mission-control" />}>
            New request
          </Button>
          <Button variant="secondary" nativeButton={false} render={<Link href="/agents?new=1" />}>
            Create agent
          </Button>
        </PageActions>
      </PageHeader>
      <DashboardKpis />
      <DashboardColumns>
        <DashboardStack>
          <DashboardMissions />
          <DashboardTeam />
          <DashboardActivity />
        </DashboardStack>
        <DashboardStack>
          <DashboardAttention />
          <DashboardWorkers />
          <DashboardCosts />
        </DashboardStack>
      </DashboardColumns>
    </DashboardStack>
  );
}
