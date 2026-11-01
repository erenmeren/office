import { describe, expect, it } from 'vitest';
import { approvalSentence, approvalTypeLabel, countdown, missionProgress, planGraphNodes } from './missions';

describe('mission helpers', () => {
  it('counts done tasks', () => {
    expect(missionProgress([])).toEqual({ done: 0, total: 0, pct: 0 });
    expect(missionProgress([{ status: 'done' }, { status: 'running' }, { status: 'done' }, { status: 'failed' }])).toEqual({ done: 2, total: 4, pct: 50 });
  });

  it('writes the approval sentence by type', () => {
    expect(approvalSentence({ type: 'destructive_command' }, 'Backend')).toBe(
      'Backend wants to run a destructive command in its worktree. The session is paused until you decide.',
    );
    expect(approvalSentence({ type: 'sensitive_path' }, 'QA')).toBe(
      'QA wants to touch a sensitive file in its worktree. The session is paused until you decide.',
    );
    expect(approvalSentence({ type: 'git_push' }, 'Backend')).toBe('Backend wants to push. The session is paused until you decide.');
    expect(approvalSentence({ type: 'merge' }, 'Backend')).toBe('Backend wants to merge. The session is paused until you decide.');
    expect(approvalSentence({ type: 'deploy' }, 'Backend')).toBe('Backend wants to deploy. The session is paused until you decide.');
    expect(approvalSentence({ type: 'budget_exceeded' }, 'Backend')).toBe('The mission would pass its budget. Tasks are held until you decide.');
  });

  it('labels approval types', () => {
    expect(approvalTypeLabel('destructive_command')).toBe('destructive command');
    expect(approvalTypeLabel('git_push')).toBe('git push');
    expect(approvalTypeLabel('budget_exceeded')).toBe('budget');
  });

  it('formats the countdown, clamped at zero', () => {
    const now = Date.parse('2026-11-01T10:00:00.000Z');
    expect(countdown(null, now)).toBeNull();
    expect(countdown('2026-11-01T10:04:32.000Z', now)).toBe('04:32');
    expect(countdown('2026-11-01T10:00:00.400Z', now)).toBe('00:01');
    expect(countdown('2026-11-01T09:59:00.000Z', now)).toBe('00:00');
    expect(countdown('2026-11-01T11:30:05.000Z', now)).toBe('90:05');
  });

  it('builds graph nodes from mission tasks with dependencies and approval gates', () => {
    const mission = {
      plan: {
        tasks: [
          { key: 'api', approvalPoints: [] },
          { key: 'deploy', approvalPoints: ['deploy' as const] },
        ],
      },
      tasks: [
        { id: 'aaaaaaaa-1111', key: 'api', title: 'API', agentId: 'a1', status: 'done', dependencies: [] },
        { id: 'bbbbbbbb-2222', key: 'deploy', title: 'Ship', agentId: 'a2', status: 'waiting_approval', dependencies: ['aaaaaaaa-1111'] },
        { id: 'cccccccc-3333', key: null, title: 'Loose', agentId: 'a3', status: 'planned', dependencies: [] },
      ],
    };
    const nodes = planGraphNodes(mission, (id) => (id === 'a1' ? 'Backend' : undefined));
    expect(nodes).toEqual([
      { id: 'aaaaaaaa-1111', code: 'api', title: 'API', assignee: 'Backend', status: 'done', dependsOn: [], gate: undefined },
      { id: 'bbbbbbbb-2222', code: 'deploy', title: 'Ship', assignee: undefined, status: 'waiting_approval', dependsOn: ['aaaaaaaa-1111'], gate: 'Approval gate: deploy' },
      { id: 'cccccccc-3333', code: 'cccccccc', title: 'Loose', assignee: undefined, status: 'planned', dependsOn: [], gate: undefined },
    ]);
  });
});
