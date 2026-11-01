import { describe, expect, it } from 'vitest';
import { relativeTime } from './workers';

describe('relativeTime', () => {
  const now = Date.parse('2026-11-01T12:00:00Z');
  const ago = (s: number) => relativeTime(new Date(now - s * 1000).toISOString(), now);
  it('picks the unit at each boundary', () => {
    expect([ago(0), ago(59), ago(60), ago(3599), ago(3600), ago(86399), ago(86400), ago(172800)]).toEqual(['0s ago', '59s ago', '1m ago', '59m ago', '1h ago', '23h ago', '1d ago', '2d ago']);
  });
});
