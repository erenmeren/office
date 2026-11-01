/** Status language (Foundations): live things glow, decisions are amber, finished things recede. */
export type Tone = 'live' | 'decision' | 'failed' | 'done' | 'idle';

const TONES: Record<string, Tone> = {
  running: 'live',
  planning: 'live',
  online: 'live',
  waiting_approval: 'decision',
  waiting_reply: 'decision',
  review: 'decision',
  blocked: 'decision',
  pending: 'decision',
  awaiting_approval: 'decision',
  failed: 'failed',
  plan_failed: 'failed',
  lost: 'failed',
  revoked: 'failed',
  done: 'done',
  succeeded: 'done',
  completed: 'done',
};

/** Unknown statuses (planned, approved, ready, queued, cancelled, offline…) recede to idle. */
export const statusTone = (status: string): Tone => TONES[status] ?? 'idle';

const LABELS: Record<string, string> = { waiting_approval: 'Needs approval', waiting_reply: 'Waiting for reply' };

export function statusLabel(status: string): string {
  const s = LABELS[status] ?? status.replace(/_/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}
