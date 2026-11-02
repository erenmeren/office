'use client';

import { KpiCard, KpiRow } from '@/components/ui/kpi-card';
import { usd } from '@/lib/dashboard';
import { useProject } from '@/lib/project';
import { useOverview, useProjects } from '@/lib/queries';

export function DashboardKpis() {
  const projects = useProjects().data ?? [];
  const o = useOverview(useProject()?.id).data;
  const busy = o ? o.agentsTotal - o.agentsAvailable : 0;
  const pct = o?.dailyBudgetUsd ? Math.round((o.costTodayUsd / o.dailyBudgetUsd) * 100) : 0;
  return (
    <KpiRow>
      <KpiCard label="Active projects" value={projects.length} sub={projects.map((p) => p.name).join(' · ')} />
      <KpiCard label="Agents available" value={o?.agentsAvailable ?? '–'} of={o && `/ ${o.agentsTotal}`} sub={o && `${busy} working now`} />
      <KpiCard
        label="Running sessions"
        value={o?.runningSessions ?? '–'}
        of={o && `/ ${o.maxConcurrentRuns}`}
        sub={o && `${o.team.filter((m) => m.status === 'needs_approval').length} paused for approval`}
      />
      <KpiCard label="Pending tasks" value={o?.pendingTasks ?? '–'} sub={o && `${o.awaitingApproval} awaiting approval`} />
      <KpiCard label="Cost today" value={o ? usd(o.costTodayUsd) : '–'} sub={o && `${pct}% of ${usd(o.dailyBudgetUsd)} daily budget`} />
    </KpiRow>
  );
}
