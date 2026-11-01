'use client';

import { BarChart } from '@/components/ui/bar-chart';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { costBars, usd } from '@/lib/dashboard';
import { useCosts, useProjects } from '@/lib/queries';

/** Daily spend for the last seven UTC days, today partial, with today's top spenders. */
export function DashboardCosts() {
  const projectId = useProjects().data?.[0]?.id;
  const week = useCosts(projectId, 7, 'day').data;
  const today = useCosts(projectId, 1, 'agent').data;
  const bars = costBars(week?.buckets ?? []);
  const partial = bars.find((b) => b.partial);
  const top = (today?.buckets ?? []).filter((b) => b.costUsd > 0).slice(0, 3);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Cost, last 7 days</CardTitle>
        {week && (
          <CardDescription>
            {usd(week.totalUsd)} total{partial && ` · ${partial.label} is partial`}
          </CardDescription>
        )}
      </CardHeader>
      <CardContent className="space-y-3">
        <BarChart bars={bars} format={usd} label={`Cost per day, last 7 days: ${bars.map((b) => `${b.label} ${usd(b.value)}`).join(', ')}`} />
        {top.length > 0 && (
          <p className="text-[12.5px] text-ink-2">Today: {top.map((b) => `${b.label} ${usd(b.costUsd)}`).join(' · ')}</p>
        )}
      </CardContent>
    </Card>
  );
}
