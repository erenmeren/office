import { describe, expect, it } from 'vitest';
import type { MessageView } from '@office/shared';
import { creatureFor, floorLayout, mailFromMessage, officeRooms, oneLine, projector, roomOrigin, sprite, themeFor, waitingMail } from './office';
import type { Agent, LiveSession, Overview } from './queries';

describe('floorLayout', () => {
  it('is the 1160×650 artboard floor, 1300 wide, for six rooms', () => {
    const l = floorLayout(6);
    expect([l.w, l.h, l.stageH, l.left, l.top, l.rows]).toEqual([1160, 650, 910, 70, 165, 2]);
    expect(l.P(0, 0, 0)).toEqual({ x: 650 - 255 * 0.70711, y: 490 - 905 * 0.35355 });
  });
  it('grows one row per three rooms and keeps a single row for one', () => {
    expect(floorLayout(7).rows).toBe(3);
    expect(floorLayout(1).h).toBe(260);
    expect(roomOrigin(4)).toEqual({ rx: 430, ry: 390 });
  });
});

it('projector lifts z along the screen', () => {
  const P = projector(100, 100, 0, 0);
  expect(P(0, 0, 10).y).toBeCloseTo(P(0, 0, 0).y - 8.6603);
});

it('sprite skips dots and uses the palette, then the base colours', () => {
  expect(sprite(['.a', 'k.'], { a: '#fff' }, 3)).toBe('3px 0px 0 0 #fff,0px 3px 0 0 #1b1033');
});

it('themes and creatures follow the role, with a fallback', () => {
  expect(['chief', 'qa-engineer', 'office-summarizer', 'frontend-dev', 'researcher'].map(themeFor)).toEqual(['library', 'board', 'fire', 'couch', 'plain']);
  expect(creatureFor('qa-engineer')).toBe(creatureFor('qa'));
  expect(creatureFor('researcher')).toBe(creatureFor('researcher'));
});

it('officeRooms joins the team with live sessions', () => {
  const team: Overview['team'] = [
    { agentId: 'a1', name: 'Developer', role: 'developer', status: 'running', currentWork: 'T1', workerName: 'w', costTodayUsd: 3 },
    { agentId: 'a2', name: 'QA', role: 'qa', status: 'idle', currentWork: null, workerName: null, costTodayUsd: 0.5 },
  ];
  const sessions = [
    { runId: 'r1', agentId: 'a1', status: 'waiting_reply', taskTitle: 'Ship it', kind: 'task', workerName: 'w', startedAt: 't', costUsd: 1.5, subagents: [{ subagentType: 'tester', status: 'running' }, { description: 'review', status: 'completed' }], waitingFor: { messageId: 'm', body: 'Why?', recipientAgentIds: ['a2'] } },
  ] as unknown as LiveSession[];
  const agents = [{ id: 'a1', slug: 'developer' }] as Agent[];
  expect(officeRooms(team, sessions, agents)).toEqual([
    { agentId: 'a1', slug: 'developer', name: 'Developer', status: 'waiting_reply', task: 'Ship it', workerName: 'w', runId: 'r1', startedAt: 't', costUsd: 1.5, subs: [{ name: 'tester', done: false }, { name: 'review', done: true }], waitingFor: { body: 'Why?', recipientAgentIds: ['a2'] } },
    { agentId: 'a2', slug: 'qa', name: 'QA', status: 'idle', task: 'No assigned work', workerName: null, runId: null, startedAt: null, costUsd: 0.5, subs: [], waitingFor: null },
  ]);
});

it('mail: live messages fly for 3.2 s, waited questions stay, own project only', () => {
  const m = { id: 'm1', projectId: 'p', senderAgentId: 'a1', deliveries: [{ recipientAgentId: 'a2' }, { recipientAgentId: 'a1' }, { recipientUserId: 'u', recipientAgentId: null }] } as unknown as MessageView;
  expect(mailFromMessage(m, 'p', 1000)).toEqual([{ id: 'm1:a2', from: 'a1', to: 'a2', until: 4200 }]);
  expect(mailFromMessage(m, 'other', 1000)).toEqual([]);
  const rooms = officeRooms(
    [{ agentId: 'a1', name: 'A', role: 'qa', status: 'running', currentWork: null, workerName: null, costTodayUsd: 0 }],
    [{ runId: 'r', agentId: 'a1', status: 'waiting_reply', kind: 'task', subagents: [], waitingFor: { messageId: 'm', body: 'Why?', recipientAgentIds: ['a2'] } }] as unknown as LiveSession[],
    [],
  );
  expect(waitingMail(rooms)).toEqual([{ id: 'wait:a1:a2', from: 'a1', to: 'a2', until: Infinity }]);
});

it('oneLine keeps the first line and cuts long text', () => {
  expect(oneLine('  Typecheck green\nwiring SSE')).toBe('Typecheck green');
  expect(oneLine('x'.repeat(80), 10)).toBe('xxxxxxxxx…');
});
