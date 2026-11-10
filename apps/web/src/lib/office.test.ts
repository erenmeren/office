import { describe, expect, it } from 'vitest';
import type { MessageView } from '@office/shared';
import { CAST_H, CAST_PAL, CAST_W, CREATURES, SMITH, ZOOM_MAX, ZOOM_MIN, clampZoom, creatureFor, floorLayout, mailFromMessage, officeRooms, oneLine, ownerRoom, projector, roomOrigin, sprite, themeFor, waitingMail, timelineLanes } from './office';
import type { Agent, ClaudeSession, LiveSession, Overview, TerminalView } from './queries';

describe('floorLayout', () => {
  it('is the 1160×650 artboard floor on a stage that holds its whole projection, for six rooms', () => {
    const l = floorLayout(6);
    expect([l.w, l.h, l.stageW, l.stageH, l.left, l.top, l.rows]).toEqual([1160, 650, 1408, 940, 124, 185, 2]);
    expect(l.P(0, 0, 0)).toEqual({ x: 704 - 255 * 0.70711, y: 510 - 905 * 0.35355 });
  });
  it('keeps every corner of a three-row floor on the stage', () => {
    const l = floorLayout(9);
    for (const [x, y] of [[0, 0], [l.w, 0], [0, l.h], [l.w, l.h]]) {
      const p = l.P(x, y);
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(l.stageW);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeLessThanOrEqual(l.stageH);
    }
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
  expect(sprite(['.a', 'k.'], { a: '#fff' }, 3)).toBe('3px 0px 0 .3px #fff,0px 3px 0 .3px #1b1033');
});

it('themes and creatures follow the role, with a fallback', () => {
  expect(['chief', 'architect', 'developer', 'designer', 'qa-engineer', 'security-engineer', 'office-summarizer', 'frontend-dev', 'researcher'].map(themeFor)).toEqual(['dojo', 'monitors', 'bike', 'garden', 'kitchen', 'teahouse', 'fire', 'couch', 'plain']);
  expect(creatureFor('qa-engineer')).toBe(creatureFor('qa'));
  expect(creatureFor('researcher')).toBe(creatureFor('researcher'));
});

it('the cast is 24×36, drawn only in its palette, and Smith is nobody’s room tenant', () => {
  for (const rows of [...Object.values(CREATURES), SMITH]) {
    expect(rows.map((r) => r.length)).toEqual(Array(CAST_H).fill(CAST_W));
    expect([...rows.join('')].filter((ch) => ch !== '.' && !CAST_PAL[ch])).toEqual([]);
  }
  expect(creatureFor('security-engineer')).toBe(CREATURES.security);
  expect(Object.values(CREATURES)).not.toContain(SMITH);
});

it('zoom stays in its range and falls back to 1 for a missing or broken stored value', () => {
  expect([0.1, 0.75, 9, 0, NaN].map(clampZoom)).toEqual([ZOOM_MIN, 0.75, ZOOM_MAX, 1, 1]);
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

it("ownerRoom counts the project's running manual and background sessions", () => {
  const t = (id: string, projectId: string, status: TerminalView['status']): TerminalView => ({ id, projectId, dir: '/d', workerId: 'w', claudeSessionId: `${id}-session`, status, startedAt: `2026-11-04T00:0${id.length}:00.000Z` });
  const bg = (sessionId: string, projectId: string, state: string): ClaudeSession => ({ sessionId, title: 'bg', cwd: '/d', lastModified: 1, projectId, workerId: 'w', workerName: 'w', local: true, live: { kind: 'background', state, id: sessionId, name: `job ${sessionId}` } });
  expect(ownerRoom([], [], 'p')).toMatchObject({ agentId: 'owner', status: 'idle', subs: [], startedAt: null });
  const room = ownerRoom([t('a', 'p', 'running'), t('bb', 'p', 'exited'), t('c', 'q', 'running')], [bg('x', 'p', 'running'), bg('y', 'p', 'done')], 'p');
  expect(room).toMatchObject({ status: 'running', task: 'Your Claude sessions: 1 manual, 1 background', workerName: 'Office terminal' });
  expect(room.subs.map((s) => s.name)).toEqual(['a-sessio', 'job x']);
  expect(['owner'].map(themeFor)).toEqual(['construct']);
});

describe('timelineLanes', () => {
  const rooms = [{ agentId: 'a' }, { agentId: 'b' }];
  const row = (agentId: string, ts: number) => ({ agentId, ts: new Date(ts).toISOString() });

  it('places events on a shared axis, oldest at 0', () => {
    const { lanes, start } = timelineLanes(rooms, [row('a', 1000), row('b', 3000), row('stranger', 0)], 5000);
    expect(start).toBe(1000);
    expect(lanes[0]!.events.map((e) => e.at)).toEqual([0]);
    expect(lanes[1]!.events.map((e) => e.at)).toEqual([0.5]);
  });

  it('keeps empty lanes when nothing happened', () => {
    expect(timelineLanes(rooms, [], 5000).lanes.map((l) => l.events)).toEqual([[], []]);
  });
});
