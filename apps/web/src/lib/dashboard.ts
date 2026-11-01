import { summarizeEvent, type OfficeEvent } from '@office/shared';
import type { ActivityItem, CostBucket } from './queries';

export interface Bar {
  label: string;
  value: number;
  partial: boolean;
}

const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Day buckets (UTC `YYYY-MM-DD` keys) as weekday bars; today's bar is partial. */
export function costBars(buckets: CostBucket[], today = new Date().toISOString().slice(0, 10)): Bar[] {
  return buckets.map((b) => ({ label: WEEKDAY[new Date(`${b.key}T00:00:00Z`).getUTCDay()], value: b.costUsd, partial: b.key === today }));
}

/** A round axis top at or above `max`: 1, 2, 5 × 10^n. */
export function niceMax(max: number): number {
  if (max <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(max));
  return [1, 2, 5, 10].map((m) => m * p).find((v) => v >= max)!;
}

export const usd = (n: number) => `$${n.toFixed(2)}`;

/** A live `project:` event as an activity row; the actor name is resolved at render time. */
export function activityFromEvent(e: OfficeEvent): ActivityItem {
  return {
    id: `${e.sessionId}:${e.seq}`,
    key: `${e.sessionId}:${e.seq}`,
    ts: e.ts,
    type: e.type,
    agentId: e.agentId,
    agentName: '',
    runId: e.runId,
    taskKey: null,
    detail: summarizeEvent(e),
  };
}

/** Live rows first, then stored ones, each event once (by `sessionId:seq`), newest `limit` kept. */
export function mergeActivity(live: ActivityItem[], stored: ActivityItem[], limit: number): ActivityItem[] {
  const seen = new Set<string>();
  return [...live, ...stored].filter((r) => !seen.has(r.key) && seen.add(r.key)).slice(0, limit);
}
