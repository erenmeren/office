'use client';

import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { ApprovalCard } from '@/components/approval-card';
import { ChiefComposer } from '@/components/chief-composer';
import { PlanCard, TaskGraphCard } from '@/components/plan-card';
import { TaskDetail, taskCode } from '@/components/task-detail';
import { Field } from '@/components/ui/field';
import { NativeSelect } from '@/components/ui/native-select';
import { PageDescription, PageHeader, PageTitle } from '@/components/ui/page-header';
import { statusLabel } from '@/lib/status';
import { useProject } from '@/lib/project';
import { useAgents, useApprovals, useMission, useMissions, useOverview, useTasks } from '@/lib/queries';
import { uiSocket } from '@/lib/ws';

export default function MissionControlPage() {
  return (
    <Suspense>
      <MissionControl />
    </Suspense>
  );
}

/** `?mission=<id>&task=<id>` (from Decisions and the Dashboard) picks the mission and the task to show. */
function MissionControl() {
  const params = useSearchParams();
  const qc = useQueryClient();
  const agents = useAgents();
  const tasks = useTasks(5000);
  const project = useProject();
  const missions = useMissions(project?.id);
  const approvals = useApprovals(project?.id, 'pending');
  const [pickedMission, setPickedMission] = useState<string | undefined>(params.get('mission') ?? undefined);
  const [picked, setPicked] = useState<string | undefined>(params.get('task') ?? undefined);
  const overview = useOverview(project?.id);

  const missionId = pickedMission ?? (picked && tasks.data?.find((t) => t.id === picked)?.missionId) ?? missions.data?.[0]?.id;
  const decisions = (overview.data?.attention ?? []).filter((a) => a.kind === 'task_decision' && a.missionId === missionId).length;
  const mission = useMission(missionId);
  const agentName = (agentId?: string) => agents.data?.find((a) => a.id === agentId)?.name;
  const loose = (tasks.data ?? []).filter((t) => !t.missionId && (!project || t.projectId === project.id));
  const pending = (approvals.data ?? []).filter((a) => a.type !== 'plan');
  const taskAgent = (taskId: string | null) => (tasks.data ?? []).find((t) => t.id === taskId)?.agentId;
  const selectedId = picked ?? (mission.data ? undefined : loose.at(-1)?.id);

  useEffect(
    () =>
      uiSocket().subscribe('global', 0, (m) => {
        if (m.type === 'approval.changed' || m.type === 'mission.status.changed') {
          void qc.invalidateQueries({ queryKey: ['missions'] });
          void qc.invalidateQueries({ queryKey: ['approvals'] });
        }
        if (m.type === 'task.status.changed' || m.type === 'run.status.changed') void qc.invalidateQueries({ queryKey: ['budget'] });
      }),
    [qc],
  );
  useEffect(() => {
    if (!missionId) return;
    return uiSocket().subscribe(`mission:${missionId}`, 0, (m) => {
      if (m.type !== 'event') void qc.invalidateQueries({ queryKey: ['missions', 'detail', missionId] });
    });
  }, [qc, missionId]);

  return (
    <div className="space-y-5">
      <PageHeader>
        <div>
          <PageTitle>Mission Control</PageTitle>
          <PageDescription>Describe the outcome. Chief writes the plan, you approve it, and the team executes it in dependency order.</PageDescription>
        </div>
      </PageHeader>

      <ChiefComposer
        project={project}
        chief={agents.data?.find((a) => a.slug === 'chief')}
        onCreated={(m) => {
          setPickedMission(m.id);
          setPicked(undefined);
        }}
      />

      {pending.map((a) => (
        <ApprovalCard key={a.id} approval={a} agentName={agentName(taskAgent(a.taskId)) ?? 'An agent'} />
      ))}

      {(missions.data?.length ?? 0) > 0 && (
        <Field label="Mission" htmlFor="mission-select">
          <NativeSelect
            id="mission-select"
            value={missionId ?? ''}
            onChange={(e) => {
              setPickedMission(e.target.value);
              setPicked(undefined);
            }}
          >
            {missions.data?.map((m) => (
              <option key={m.id} value={m.id}>
                {m.title} · {statusLabel(m.status)}
              </option>
            ))}
          </NativeSelect>
        </Field>
      )}

      {mission.data && (
        <PlanCard key={`${mission.data.id}:${mission.data.planVersion}`} mission={mission.data} agents={agents.data ?? []} selectedId={picked} onSelect={setPicked} decisions={decisions} />
      )}

      {loose.length > 0 && (
        <TaskGraphCard
          title="Tasks without a mission"
          nodes={loose.map((t) => ({ id: t.id, code: taskCode(t.id), title: t.title, assignee: agentName(t.agentId), status: t.status, dependsOn: [] }))}
          selectedId={selectedId}
          onSelect={setPicked}
        />
      )}

      {selectedId && <TaskDetail key={selectedId} taskId={selectedId} />}
    </div>
  );
}
