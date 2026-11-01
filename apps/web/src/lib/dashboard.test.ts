import { describe, expect, it } from 'vitest';
import type { OfficeEvent } from '@office/shared';
import { activityFromEvent, costBars, niceMax } from './dashboard';

const bucket = (key: string, costUsd: number) => ({ key, label: key, costUsd, inputTokens: 0, outputTokens: 0 });

describe('dashboard helpers', () => {
  it('labels day buckets by UTC weekday and marks today partial', () => {
    const bars = costBars([bucket('2026-10-31', 4), bucket('2026-11-01', 1.5)], '2026-11-01');
    expect(bars).toEqual([
      { label: 'Sat', value: 4, partial: false },
      { label: 'Sun', value: 1.5, partial: true },
    ]);
  });

  it('rounds the axis top up to 1, 2 or 5 × 10^n', () => {
    expect(niceMax(0)).toBe(1);
    expect(niceMax(18.42)).toBe(20);
    expect(niceMax(3)).toBe(5);
    expect(niceMax(0.3)).toBe(0.5);
    expect(niceMax(100)).toBe(100);
  });

  it('turns a live event into an activity row', () => {
    const e = { type: 'agent.command.executed', seq: 7, ts: '2026-11-01T10:00:00.000Z', sessionId: 's', runId: 'r', agentId: 'a', projectId: 'p', payload: { command: 'pnpm test' } } as OfficeEvent;
    expect(activityFromEvent(e, 'Backend Dev')).toMatchObject({ id: 's:7', agentName: 'Backend Dev', detail: '$ pnpm test' });
  });
});
