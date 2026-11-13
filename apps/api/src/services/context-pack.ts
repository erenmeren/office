import type { MemoryEntry } from '@office/db';
import { searchIds } from './memory-service.js';
import type { Db } from './task-service.js';

const HEADER = '## Context pack\nCite entries by id (m:<id>). Entries are facts verified by the owner; the inbox is unread mail.';

const line = (e: Pick<MemoryEntry, 'id' | 'type' | 'title' | 'content'>) =>
  `- [m:${e.id}] ${e.type} · ${e.title}: ${e.content.slice(0, 400).replace(/\s*\n\s*/g, ' ')}`;

export async function buildContextPack(
  db: Db,
  /** `conversationId`: the inbox section lists only that conversation's mail (a Conductor run answers one tab) */
  a: { projectId: string; agentId: string; taskText: string; maxChars: number; conversationId?: string },
): Promise<{ text: string; entryIds: string[]; summaryIds: string[]; inboxCount: number }> {
  const verified = { projectId: a.projectId, status: 'verified' as const, supersededById: null };
  const entryIds: string[] = [];
  const summaryIds: string[] = [];
  const seen = new Set<string>();
  const sections: { title: string; items: { text: string; id?: string; summary?: boolean }[] }[] = [];

  const overview = await db.memoryEntry.findFirst({ where: { ...verified, title: 'Project overview' } });
  if (overview) {
    seen.add(overview.id);
    sections.push({ title: '### Project overview', items: [{ text: line(overview), id: overview.id }] });
  }

  const taskText = a.taskText.slice(0, 2000).trim();
  if (taskText) {
    const ids = await searchIds(db, { projectId: a.projectId, q: taskText, status: 'verified', limit: 10, anyWord: true });
    const rows = await db.memoryEntry.findMany({ where: { id: { in: ids } } });
    const items = ids
      .map((id) => rows.find((r) => r.id === id))
      .filter((r): r is MemoryEntry => !!r && !seen.has(r.id))
      .map((r) => ({ text: line(r), id: r.id }));
    items.forEach((i) => seen.add(i.id));
    if (items.length) sections.push({ title: '### Relevant memory', items });
  }

  const summaries = await db.memoryEntry.findMany({
    where: { ...verified, type: 'task_summary' },
    orderBy: { createdAt: 'desc' },
    take: 3,
  });
  if (summaries.length) {
    sections.push({
      title: '### Recent task summaries',
      items: summaries.map((s) => ({ text: line(s), id: s.id, summary: true })),
    });
  }

  const inbox = await db.messageDelivery.findMany({
    where: { recipientAgentId: a.agentId, status: { in: ['pending', 'delivered'] }, message: { projectId: a.projectId, conversationId: a.conversationId } },
    include: { message: { select: { body: true } } },
    orderBy: { createdAt: 'asc' },
  });
  if (inbox.length) {
    sections.push({
      title: `### Inbox (${inbox.length} unread)`,
      items: inbox.slice(0, 5).map((d) => ({ text: `- ${d.message.body.slice(0, 120).replace(/\s*\n\s*/g, ' ')}` })),
    });
  }

  const lessons = await db.memoryEntry.findMany({
    where: {
      status: 'verified',
      supersededById: null,
      OR: [{ projectId: null }, { projectId: a.projectId }],
      type: 'lesson',
      agentId: a.agentId, scope: { in: ['agent', 'agent_project'] } },
    orderBy: { createdAt: 'desc' },
    take: 5,
  });
  if (lessons.length) {
    sections.push({ title: '### Your lessons', items: lessons.map((l) => ({ text: line(l), id: l.id })) });
  }

  if (sections.length === 0) return { text: '', entryIds, summaryIds, inboxCount: inbox.length };

  let text = HEADER;
  for (const s of sections) {
    let started = false;
    for (const item of s.items) {
      const add = (started ? '' : `\n\n${s.title}`) + `\n${item.text}`;
      if (text.length + add.length > a.maxChars) break;
      text += add;
      started = true;
      if (item.id && !entryIds.includes(item.id)) entryIds.push(item.id);
      if (item.summary && item.id) summaryIds.push(item.id);
    }
  }
  return { text, entryIds, summaryIds, inboxCount: inbox.length };
}
