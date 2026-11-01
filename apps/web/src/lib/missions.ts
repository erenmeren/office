import type { ApprovalType } from '@office/shared';
import type { PlanGraphNode } from '@/components/plan-graph';

export function missionProgress(tasks: { status: string }[]) {
  const done = tasks.filter((t) => t.status === 'done').length;
  return { done, total: tasks.length, pct: tasks.length ? (done / tasks.length) * 100 : 0 };
}

const LABELS: Record<ApprovalType, string> = {
  plan: 'plan',
  git_push: 'git push',
  merge: 'merge',
  deploy: 'deploy',
  destructive_command: 'destructive command',
  sensitive_path: 'sensitive path',
  budget_exceeded: 'budget',
};
export const approvalTypeLabel = (type: ApprovalType) => LABELS[type];

const PAUSED = 'The session is paused until you decide.';
const VERBS: Partial<Record<ApprovalType, string>> = { git_push: 'push', merge: 'merge', deploy: 'deploy' };

export function approvalSentence(approval: { type: ApprovalType }, agentName: string): string {
  switch (approval.type) {
    case 'destructive_command':
      return `${agentName} wants to run a destructive command in its worktree. ${PAUSED}`;
    case 'sensitive_path':
      return `${agentName} wants to touch a sensitive file in its worktree. ${PAUSED}`;
    case 'budget_exceeded':
      return 'The mission would pass its budget. Tasks are held until you decide.';
    default:
      return `${agentName} wants to ${VERBS[approval.type] ?? approvalTypeLabel(approval.type)}. ${PAUSED}`;
  }
}

/** Time left until `expiresAt` as mm:ss, rounded up and clamped at 00:00; null without a deadline. */
export function countdown(expiresAt: string | null, now: number): string | null {
  if (!expiresAt) return null;
  const s = Math.max(0, Math.ceil((Date.parse(expiresAt) - now) / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

interface GraphMission {
  plan: { tasks: { key: string; approvalPoints?: ApprovalType[] }[] } | null;
  tasks: { id: string; key: string | null; title: string; agentId: string; status: string; dependencies: string[] }[];
}

export function planGraphNodes(mission: GraphMission, agentName: (agentId: string) => string | undefined = () => undefined): PlanGraphNode[] {
  return mission.tasks.map((t) => {
    const points = mission.plan?.tasks.find((p) => p.key === t.key)?.approvalPoints ?? [];
    return {
      id: t.id,
      code: t.key ?? t.id.slice(0, 8),
      title: t.title,
      assignee: agentName(t.agentId),
      status: t.status,
      dependsOn: t.dependencies,
      gate: points.length ? `Approval gate: ${points.map(approvalTypeLabel).join(', ')}` : undefined,
    };
  });
}
