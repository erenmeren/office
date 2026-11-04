import { describe, expect, it } from 'vitest';
import { draftFromTranscript } from './mission-draft';

const session = { title: 'Fix login', sessionId: 'abcdef12-0000', cwd: '/home/me/app' };

describe('draftFromTranscript', () => {
  it('keeps the newest turns in order, trims each, and names the session', () => {
    const turns = [
      { role: 'user' as const, text: 'first\n\nline' },
      { role: 'assistant' as const, text: '' },
      { role: 'assistant' as const, text: 'x'.repeat(700) },
      { role: 'user' as const, text: 'last' },
    ];
    const d = draftFromTranscript(session, turns);
    const lines = d.split('\n');
    expect(lines[0]).toBe('Fix login');
    expect(lines[2]).toContain('/home/me/app (abcdef12)');
    expect(lines.slice(4)).toEqual(['Me: first line', `Claude: ${'x'.repeat(600)}`, 'Me: last']);
  });

  it('drops the oldest turns past the size cap', () => {
    const turns = Array.from({ length: 30 }, (_, i) => ({ role: 'user' as const, text: `turn ${i} ${'y'.repeat(500)}` }));
    const d = draftFromTranscript(session, turns);
    expect(d).toContain('turn 29');
    expect(d).not.toContain('turn 0 ');
    expect(d.length).toBeLessThan(6500);
  });
});
