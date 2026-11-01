import { describe, expect, it } from 'vitest';
import { memoryStatusLabel, memoryStatusTone, memoryTypeLabel, sourceLabel } from './memory';

describe('memory helpers', () => {
  it('labels types', () => {
    expect(memoryTypeLabel('decision')).toBe('Decision');
    expect(memoryTypeLabel('task_summary')).toBe('Task history');
    expect(memoryTypeLabel('known_issue')).toBe('Known issue');
    expect(memoryTypeLabel('convention')).toBe('Knowledge');
    expect(memoryTypeLabel('api_contract')).toBe('Knowledge');
    expect(memoryTypeLabel('lesson')).toBe('Agent learning');
  });
  it('maps status to tone and label', () => {
    expect(memoryStatusTone('verified')).toBe('done');
    expect(memoryStatusTone('proposed')).toBe('decision');
    expect(memoryStatusTone('rejected')).toBe('failed');
    expect(memoryStatusLabel('proposed')).toBe('Needs review');
    expect(memoryStatusLabel('verified')).toBe('Verified');
    expect(memoryStatusLabel('rejected')).toBe('Rejected');
  });
  it('labels sources', () => {
    const s = (kind: string, ref: string, label: string | null = null) => sourceLabel({ id: 'x', kind: kind as 'run', ref, label });
    expect(s('run', '1234567890')).toBe('Run 12345678');
    expect(s('commit', '1234567890')).toBe('Commit 1234567');
    expect(s('file', 'src/a.ts')).toBe('src/a.ts');
    expect(s('event', '42')).toBe('Event 42');
    expect(s('task', '1234567890', 'Fix login')).toBe('Fix login');
  });
});
