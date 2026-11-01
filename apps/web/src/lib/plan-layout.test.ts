import { describe, expect, it } from 'vitest';
import { layoutPlan } from './plan-layout';
import { statusLabel, statusTone } from './status';
import { agentGradient, initials } from './agent-identity';

describe('layoutPlan', () => {
  it('places dependents one column after their deepest dependency', () => {
    const cells = layoutPlan([
      { id: 'a', dependsOn: [] },
      { id: 'b', dependsOn: ['a'] },
      { id: 'c', dependsOn: ['a'] },
      { id: 'd', dependsOn: ['b', 'c'] },
    ]);
    expect(cells.get('a')).toEqual({ col: 0, row: 0 });
    expect(cells.get('b')).toEqual({ col: 1, row: 0 });
    expect(cells.get('c')).toEqual({ col: 1, row: 1 });
    expect(cells.get('d')).toEqual({ col: 2, row: 0 });
  });

  it('wraps a flat plan into columns of maxRows', () => {
    const nodes = ['1', '2', '3', '4', '5'].map((id) => ({ id, dependsOn: [] }));
    const cells = layoutPlan(nodes, 2);
    expect(cells.get('1')).toEqual({ col: 0, row: 0 });
    expect(cells.get('2')).toEqual({ col: 0, row: 1 });
    expect(cells.get('3')).toEqual({ col: 1, row: 0 });
    expect(cells.get('5')).toEqual({ col: 2, row: 0 });
  });

  it('ignores unknown and cyclic dependencies', () => {
    const cells = layoutPlan([
      { id: 'a', dependsOn: ['b', 'ghost'] },
      { id: 'b', dependsOn: ['a'] },
    ]);
    expect(cells.size).toBe(2);
    expect([...cells.values()].every((c) => c.col <= 1)).toBe(true);
  });
});

describe('status language', () => {
  it('maps statuses to tones and labels', () => {
    expect(statusTone('running')).toBe('live');
    expect(statusTone('waiting_approval')).toBe('decision');
    expect(statusTone('lost')).toBe('failed');
    expect(statusTone('succeeded')).toBe('done');
    expect(statusTone('planned')).toBe('idle');
    expect(statusLabel('waiting_approval')).toBe('Needs approval');
    expect(statusLabel('waiting_reply')).toBe('Waiting for reply');
    expect(statusLabel('done')).toBe('Done');
  });
});

describe('agent identity', () => {
  it('derives initials and stable gradients', () => {
    expect(initials('Frontend Dev')).toBe('FD');
    expect(initials('QA Engineer')).toBe('QA');
    expect(initials('qa-engineer')).toBe('QE');
    expect(initials('Chief')).toBe('CH');
    expect(initials('Developer')).toBe('DV');
    expect(initials('Designer')).toBe('DS');
    expect(initials('Architect')).toBe('AR');
    expect(agentGradient('chief')).toEqual(['#b39dff', '#ff6ad5']);
    expect(agentGradient('qa-engineer')).toEqual(['#ffe14d', '#b8f25a']);
    expect(agentGradient('zed')).toEqual(agentGradient('zed'));
  });
});
