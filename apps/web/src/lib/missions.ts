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
    case 'plan':
      return `${agentName}'s plan is ready. The tasks are created when you approve it.`;
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

export interface MissionStatusInput {
  status: string;
  /** tasks per status, as `MissionSummary.taskCounts` */
  taskCounts: Record<string, number>;
  summary?: string | null;
  planError?: string | null;
  /** tasks of this mission waiting for the owner's review decision (overview attention `task_decision`) */
  decisions?: number;
}

const count = (c: Record<string, number>, ...statuses: string[]) => statuses.reduce((n, s) => n + (c[s] ?? 0), 0);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** One sentence saying what the mission is doing and who it waits for; `yours` when the next step is the owner's. */
export function missionStatusLine(m: MissionStatusInput): { text: string; yours: boolean } {
  const c = m.taskCounts;
  const total = count(c, ...Object.keys(c));
  const done = count(c, 'done');
  const first = (s: string | null | undefined) => s?.split(/(?<=\.)\s/)[0] ?? '';
  switch (m.status) {
    case 'planning':
      return { text: 'Chief is writing the plan. Nothing to decide yet.', yours: false };
    case 'plan_failed':
      return { text: `Planning failed${m.planError ? `: ${first(m.planError)}` : ''}. Replan or cancel the mission.`, yours: true };
    case 'awaiting_approval':
      return { text: 'Waiting for you: approve the plan to start the tasks.', yours: true };
    case 'approved':
      return { text: 'Plan approved. The first tasks start when a worker is free.', yours: false };
    case 'running': {
      const approvals = count(c, 'waiting_approval');
      if (approvals) return { text: `Waiting for you: ${plural(approvals, 'task')} paused for an approval. ${done} of ${total} done.`, yours: true };
      const running = count(c, 'running', 'queued', 'waiting_reply');
      const waiting = count(c, 'ready', 'planned', 'blocked');
      return { text: `Running: ${plural(running, 'task')} active, ${waiting} waiting for a worker or a dependency, ${done} of ${total} done.`, yours: false };
    }
    case 'review':
      if (m.decisions) return { text: `Waiting for you: ${plural(m.decisions, 'task')} need${m.decisions === 1 ? 's' : ''} your decision in Decisions.`, yours: true };
      return { text: `Chief is reviewing the results. ${done} of ${total} done.`, yours: false };
    case 'done':
      return { text: `Done: all ${plural(total, 'task')} finished.`, yours: false };
    case 'failed':
      return { text: `Failed${m.summary ? `: ${first(m.summary)}` : ''} Retry a failed task in Mission Control or send a new request.`, yours: true };
    case 'cancelled':
      return { text: 'Cancelled by you. Nothing is running.', yours: false };
    default:
      return { text: m.status, yours: false };
  }
}

/** Task statuses as counts, for `missionStatusLine`. */
export function taskCounts(tasks: { status: string }[]): Record<string, number> {
  return tasks.reduce<Record<string, number>>((acc, t) => ((acc[t.status] = (acc[t.status] ?? 0) + 1), acc), {});
}
