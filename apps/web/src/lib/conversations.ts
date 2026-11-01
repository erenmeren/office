import type { MessageView } from '@office/shared';

type Named = { id: string; name: string };
interface TitleInput {
  kind: 'direct' | 'group' | 'task' | 'human';
  title: string;
  agentIds: string[];
}

/** Display title; `human` and `direct` threads are named after their participants. */
export function conversationTitle(c: TitleInput, agents: Named[]): string {
  const name = (id: string) => agents.find((a) => a.id === id)?.name ?? 'Agent';
  if (c.kind === 'human') return `You and ${name(c.agentIds[0])}`;
  if (c.kind === 'direct') return `${name(c.agentIds[0])} and ${name(c.agentIds[1])}`;
  return c.title;
}

const pad = (n: number) => String(n).padStart(2, '0');
const localDay = (iso: string) => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

/** Consecutive messages grouped by local calendar day (input is ascending). */
export function groupByDay<T extends { createdAt: string }>(messages: T[]): { day: string; messages: T[] }[] {
  const groups: { day: string; messages: T[] }[] = [];
  for (const m of messages) {
    const day = localDay(m.createdAt);
    const last = groups.at(-1);
    if (last?.day === day) last.messages.push(m);
    else groups.push({ day, messages: [m] });
  }
  return groups;
}

const TYPE_LABELS: Record<MessageView['type'], string> = {
  message: 'Note',
  question: 'Question',
  reply: 'Reply',
  handoff: 'Handoff',
  help_request: 'Help request',
  escalation: 'Escalation',
  artifact: 'Artifact',
};
export const messageTypeLabel = (type: MessageView['type']) => TYPE_LABELS[type];

export const timeOf = (iso: string) => {
  const d = new Date(iso);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/** The API does not expose acknowledgedAt, so "Read" uses the message time. */
export function deliveryLine(m: { createdAt: string; deliveries: { status: string }[] }): string {
  if (m.deliveries.length === 0) return '';
  if (m.deliveries.some((d) => d.status === 'acknowledged')) return `Read ${timeOf(m.createdAt)}`;
  if (m.deliveries.every((d) => d.status === 'pending')) return 'Saved · delivers at the next session boundary';
  return 'Delivered';
}
