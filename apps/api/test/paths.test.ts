import { describe, expect, it } from 'vitest';
import { isUnderRoot } from '../src/lib/paths.js';

describe('isUnderRoot', () => {
  it('matches by path segment, not string prefix', () => {
    expect(isUnderRoot('/tmp/office-ws/p1', '/tmp/office-ws')).toBe(true);
    expect(isUnderRoot('/tmp/office-ws', '/tmp/office-ws')).toBe(true);
    expect(isUnderRoot('/tmp/office-ws/p1', '/tmp/office-ws/')).toBe(true);
    expect(isUnderRoot('/tmp/office-ws-evil/p1', '/tmp/office-ws')).toBe(false);
    expect(isUnderRoot('/tmp/office-ws/../etc', '/tmp/office-ws')).toBe(false);
    expect(isUnderRoot('/anything', '/')).toBe(true);
  });
});
