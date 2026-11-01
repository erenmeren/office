import { describe, expect, it } from 'vitest';
import { conversationTitle, deliveryLine, groupByDay, messageTypeLabel } from './conversations';

const agents = [
  { id: 'a1', name: 'Chief' },
  { id: 'a2', name: 'QA' },
];
const base = { title: 'T', agentIds: ['a1', 'a2'] };

describe('conversationTitle', () => {
  it('names every kind', () => {
    expect(conversationTitle({ ...base, kind: 'human', agentIds: ['a2'] }, agents)).toBe('You and QA');
    expect(conversationTitle({ ...base, kind: 'direct' }, agents)).toBe('Chief and QA');
    expect(conversationTitle({ ...base, kind: 'task', title: 'Fix login' }, agents)).toBe('Fix login');
    expect(conversationTitle({ ...base, kind: 'group', title: 'Launch' }, agents)).toBe('Launch');
  });
});

describe('groupByDay', () => {
  it('splits by local date', () => {
    const at = (h: number, d: number) => ({ createdAt: new Date(2026, 10, d, h).toISOString() });
    const g = groupByDay([at(9, 1), at(23, 1), at(1, 2)]);
    expect(g.map((x) => x.messages.length)).toEqual([2, 1]);
    expect(g[0].day).toBe('2026-11-01');
  });
});

describe('labels', () => {
  it('types and delivery', () => {
    expect(messageTypeLabel('message')).toBe('Note');
    expect(messageTypeLabel('help_request')).toBe('Help request');
    const m = (...s: string[]) => ({ createdAt: new Date(2026, 10, 1, 9, 5).toISOString(), deliveries: s.map((status) => ({ status })) });
    expect(deliveryLine(m('pending', 'pending'))).toBe('Saved · delivers at the next session boundary');
    expect(deliveryLine(m('pending', 'acknowledged'))).toMatch(/^Read \d{2}:\d{2}$/);
    expect(deliveryLine(m('delivered'))).toBe('Delivered');
  });
});
