import { describe, expect, it } from 'vitest';
import { creatureFor, floorLayout, officeRooms, projector, roomOrigin, sprite, themeFor } from './office';
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
    { runId: 'r1', agentId: 'a1', status: 'waiting_reply', taskTitle: 'Ship it', kind: 'task', workerName: 'w', startedAt: 't', costUsd: 1.5, subagents: [{ subagentType: 'tester', status: 'running' }, { description: 'review', status: 'completed' }] },
  ] as unknown as LiveSession[];
  const agents = [{ id: 'a1', slug: 'developer' }] as Agent[];
  expect(officeRooms(team, sessions, agents)).toEqual([
    { agentId: 'a1', slug: 'developer', name: 'Developer', status: 'waiting_reply', task: 'Ship it', workerName: 'w', runId: 'r1', startedAt: 't', costUsd: 1.5, subs: [{ name: 'tester', done: false }, { name: 'review', done: true }] },
    { agentId: 'a2', slug: 'qa', name: 'QA', status: 'idle', task: 'No assigned work', workerName: null, runId: null, startedAt: null, costUsd: 0.5, subs: [] },
  ]);
});
