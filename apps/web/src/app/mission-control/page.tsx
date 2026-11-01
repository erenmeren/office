'use client';

import { useState } from 'react';
import { ChiefComposer } from '@/components/chief-composer';
import { PlanGraph } from '@/components/plan-graph';
import { TaskDetail, taskCode } from '@/components/task-detail';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { PageDescription, PageHeader, PageTitle } from '@/components/ui/page-header';
import { Progress } from '@/components/ui/progress';
import { StatusDot } from '@/components/ui/status-pill';
import { useAgents, useProjects, useTasks } from '@/lib/queries';
import type { Tone } from '@/lib/status';

const LEGEND: [Tone, string][] = [
  ['done', 'Done'],
  ['live', 'Running'],
  ['decision', 'Needs a decision'],
  ['idle', 'Queued'],
];

export default function MissionControlPage() {
  const projects = useProjects();
  const agents = useAgents();
  const tasks = useTasks(5000);
  const [picked, setPicked] = useState<string>();

  const project = projects.data?.[0];
  const chief = agents.data?.find((a) => a.slug === 'chief');
  const list = (tasks.data ?? []).filter((t) => !project || t.projectId === project.id);
  const selectedId = picked ?? list.at(-1)?.id;
  const done = list.filter((t) => t.status === 'done').length;

  return (
    <div className="space-y-5">
      <PageHeader>
        <div>
          <PageTitle>Mission Control</PageTitle>
          <PageDescription>Describe the outcome. Chief writes the plan, you approve it, and the team executes it in dependency order.</PageDescription>
        </div>
      </PageHeader>

      <ChiefComposer project={project} chief={chief} onCreated={(t) => setPicked(t.id)} />

      <Card>
        <CardHeader>
          <CardTitle>Plan · {project?.name ?? 'no project'}</CardTitle>
          <CardDescription>Tasks in creation order. Dependencies draw as arrows once a plan has them.</CardDescription>
          <CardAction className="flex min-w-[200px] items-center gap-3 self-center">
            <span className="font-mono text-[12.5px] whitespace-nowrap text-ink-2">
              {done} of {list.length} done
            </span>
            <Progress value={list.length ? (done / list.length) * 100 : 0} label="Plan progress" className="w-[140px]" />
          </CardAction>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap gap-x-5 gap-y-2 text-[12.5px] text-ink-2">
            {LEGEND.map(([tone, label]) => (
              <span key={tone} className="inline-flex items-center gap-2">
                <StatusDot tone={tone} />
                {label}
              </span>
            ))}
          </div>
          {tasks.isPending ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : (
            <PlanGraph
              nodes={list.map((t) => ({
                id: t.id,
                code: taskCode(t.id),
                title: t.title,
                assignee: agents.data?.find((a) => a.id === t.agentId)?.name,
                status: t.status,
                dependsOn: [],
              }))}
              selectedId={selectedId}
              onSelect={setPicked}
            />
          )}
        </CardContent>
      </Card>

      {selectedId && <TaskDetail key={selectedId} taskId={selectedId} />}
    </div>
  );
}
