import { embed, embeddingsReady } from '../lib/embeddings.js';
import { Prisma, type MemoryEntry, type MemorySource } from '@office/db';
import type { MemoryScope, MemorySourceInput, MemoryStatus, MemoryType } from '@office/shared';
import { HttpError } from '../lib/errors.js';
import type { Db } from './task-service.js';

export type MemoryEntryView = MemoryEntry & {
  sources: MemorySource[];
  supersedes: { id: string; version: number } | null;
};

export type MemoryRevision = {
  id: string;
  version: number;
  title: string;
  createdAt: Date;
  status: MemoryStatus;
  authorType: string;
};

export type CreateEntryInput = {
  projectId?: string;
  agentId?: string;
  scope: MemoryScope;
  type: MemoryType;
  title: string;
  content: string;
  authorType: string;
  authorAgentId?: string;
  status: MemoryStatus;
  taskId?: string;
  runId?: string;
  sources: MemorySourceInput[];
};

export async function createEntry(db: Db, input: CreateEntryInput) {
  const { sources, ...data } = input;
  return db.memoryEntry.create({
    data: {
      ...data,
      verifiedAt: data.status === 'verified' ? new Date() : null,
      sources: { create: sources },
    },
    include: { sources: true },
  });
}

async function withSupersedes(db: Db, rows: (MemoryEntry & { sources: MemorySource[] })[]): Promise<MemoryEntryView[]> {
  const prev = await db.memoryEntry.findMany({
    where: { supersededById: { in: rows.map((r) => r.id) } },
    select: { id: true, version: true, supersededById: true },
  });
  return rows.map((r) => {
    const p = prev.find((x) => x.supersededById === r.id);
    return { ...r, supersedes: p ? { id: p.id, version: p.version } : null };
  });
}

export async function searchMemory(
  db: Db,
  f: { projectId: string; q?: string; type?: MemoryType; status?: MemoryStatus; agentId?: string; limit?: number },
): Promise<MemoryEntryView[]> {
  const limit = f.limit ?? 20;
  const q = f.q?.trim();
  if (!q) {
    const rows = await db.memoryEntry.findMany({
      where: {
        projectId: f.projectId,
        supersededById: null,
        ...(f.type && { type: f.type }),
        ...(f.status && { status: f.status }),
        ...(f.agentId && { agentId: f.agentId }),
      },
      include: { sources: true },
      orderBy: { updatedAt: 'desc' },
      take: limit,
    });
    return withSupersedes(db, rows);
  }
  return loadOrdered(db, await searchIds(db, { ...f, q, limit }));
}

/** Reciprocal rank fusion: an id high in either list ranks high, and in both ranks highest. */
export function fuseRanks(lists: string[][], limit: number): string[] {
  const scores = new Map<string, number>();
  for (const list of lists) list.forEach((id, i) => scores.set(id, (scores.get(id) ?? 0) + 1 / (60 + i)));
  return [...scores].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([id]) => id);
}

// unrelated text scored under 0.2 on the real model, a Turkish question about an English entry 0.38
const MIN_SIMILARITY = 0.3;

type MemoryFilter = { projectId: string; q: string; type?: MemoryType; status?: MemoryStatus; agentId?: string; limit: number };

const memoryFilters = (f: Omit<MemoryFilter, 'q' | 'limit'>) => [
  f.type ? Prisma.sql`AND "type" = ${f.type}::"MemoryType"` : Prisma.empty,
  f.status ? Prisma.sql`AND "status" = ${f.status}::"MemoryStatus"` : Prisma.empty,
  f.agentId ? Prisma.sql`AND "agentId" = ${f.agentId}` : Prisma.empty,
];

/** Entry ids close in meaning to `q`. shortcut: scans the project's vectors in JS; move to pgvector if a project passes some 50k entries. */
async function semanticIds(db: Db, f: MemoryFilter): Promise<string[]> {
  const query = await embed(f.q);
  if (!query) return [];
  const rows = await db.$queryRaw<{ id: string; v: number[] }[]>`
    SELECT "id", "localEmbedding" AS v FROM "MemoryEntry"
    WHERE "projectId" = ${f.projectId} AND "supersededById" IS NULL AND "localEmbedding" IS NOT NULL
      ${Prisma.join(memoryFilters(f), ' ')}`;
  return rows
    .map((r) => ({ id: r.id, score: r.v.reduce((sum, x, i) => sum + x * query[i]!, 0) }))
    .filter((r) => r.score >= MIN_SIMILARITY)
    .sort((a, b) => b.score - a.score)
    .slice(0, f.limit)
    .map((r) => r.id);
}

/** Keyword and semantic matches together; keywords alone when embeddings are off. */
export async function searchIds(db: Db, f: MemoryFilter & { anyWord?: boolean }): Promise<string[]> {
  const [keyword, semantic] = await Promise.all([ftsIds(db, f), semanticIds(db, f)]);
  return fuseRanks([keyword, semantic], f.limit);
}

/** Embeds entries that have no vector yet; returns how many it stored. */
export async function embedMissingMemory(db: Db, limit: number, log?: { warn: (obj: object, msg: string) => void }): Promise<number> {
  if (!embeddingsReady()) return 0;
  const rows = await db.$queryRaw<{ id: string; title: string; content: string }[]>`
    SELECT "id", "title", "content" FROM "MemoryEntry" WHERE "localEmbedding" IS NULL ORDER BY "createdAt" LIMIT ${limit}`;
  let stored = 0;
  for (const r of rows) {
    const v = await embed(`${r.title}\n${r.content}`, log);
    if (!v) break;
    await db.$executeRaw`UPDATE "MemoryEntry" SET "localEmbedding" = ${v}::double precision[] WHERE "id" = ${r.id}`;
    stored++;
  }
  return stored;
}

/** Entry ids matching `q`, best rank first. Superseded rows are always excluded. */
export async function ftsIds(
  db: Db,
  f: { projectId: string; q: string; type?: MemoryType; status?: MemoryStatus; agentId?: string; limit: number; anyWord?: boolean },
): Promise<string[]> {
  // anyWord: long task text rarely matches every term, so OR the lexemes instead of AND.
  const tsq = f.anyWord
    ? Prisma.sql`replace(plainto_tsquery('english', ${f.q})::text, ' & ', ' | ')::tsquery`
    : Prisma.sql`plainto_tsquery('english', ${f.q})`;
  const filters = memoryFilters(f);
  const rows = await db.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "MemoryEntry"
    WHERE "projectId" = ${f.projectId} AND "supersededById" IS NULL
      AND "search" @@ ${tsq}
      ${Prisma.join(filters, ' ')}
    ORDER BY ts_rank("search", ${tsq}) DESC
    LIMIT ${f.limit}`;
  return rows.map((r) => r.id);
}

export async function loadOrdered(db: Db, ids: string[]): Promise<MemoryEntryView[]> {
  if (ids.length === 0) return [];
  const rows = await db.memoryEntry.findMany({ where: { id: { in: ids } }, include: { sources: true } });
  const byId = new Map(rows.map((r) => [r.id, r]));
  return withSupersedes(db, ids.map((id) => byId.get(id)).filter((r) => r !== undefined));
}

// A supplied projectId must equal the row's; without one any row (even project-less) passes.
async function ownEntry(db: Db, id: string, projectId?: string) {
  const e = await db.memoryEntry.findUnique({ where: { id }, include: { sources: true } });
  if (!e || (projectId !== undefined && e.projectId !== projectId)) throw new HttpError(404, 'not_found');
  return e;
}

export async function getEntry(db: Db, id: string, projectId: string) {
  const e = await ownEntry(db, id, projectId);
  const [view] = await withSupersedes(db, [e]);
  const revisions: MemoryRevision[] = [];
  const pick = { id: true, version: true, title: true, createdAt: true, status: true, authorType: true } as const;
  revisions.push({ id: e.id, version: e.version, title: e.title, createdAt: e.createdAt, status: e.status, authorType: e.authorType });
  let cur = e.id;
  for (;;) {
    const p = await db.memoryEntry.findFirst({ where: { supersededById: cur }, select: pick });
    if (!p) break;
    revisions.push(p);
    cur = p.id;
  }
  return { ...view!, revisions };
}

async function setStatus(db: Db, id: string, projectId: string | undefined, status: MemoryStatus) {
  const e = await ownEntry(db, id, projectId);
  if (status === 'verified' && e.status === 'verified') return e; // keep the original verifiedAt
  return db.memoryEntry.update({
    where: { id },
    data: { status, verifiedAt: status === 'verified' ? new Date() : null },
    include: { sources: true },
  });
}

export const verifyEntry = (db: Db, id: string, projectId?: string) => setStatus(db, id, projectId, 'verified');
export const rejectEntry = (db: Db, id: string, projectId?: string) => setStatus(db, id, projectId, 'rejected');

export async function supersedeEntry(
  db: Db,
  id: string,
  projectId: string | undefined,
  input: { title: string; content: string; type?: MemoryType; sources?: MemorySourceInput[]; actor: 'user' | 'agent' },
) {
  const run = async (tx: Db) => {
    const old = await ownEntry(tx, id, projectId);
    const fresh = await tx.memoryEntry.create({
      data: {
        projectId: old.projectId,
        agentId: old.agentId,
        scope: old.scope,
        type: input.type ?? old.type,
        title: input.title,
        content: input.content,
        authorType: input.actor,
        authorAgentId: input.actor === 'agent' ? old.authorAgentId : null,
        status: input.actor === 'user' ? 'verified' : 'proposed',
        verifiedAt: input.actor === 'user' ? new Date() : null,
        version: old.version + 1,
        taskId: old.taskId,
        runId: old.runId,
        sources: { create: input.sources ?? [] },
      },
      include: { sources: true },
    });
    // Guarded flip: a concurrent supersede loses here and rolls the new row back.
    const flipped = await tx.memoryEntry.updateMany({ where: { id: old.id, supersededById: null }, data: { supersededById: fresh.id } });
    if (flipped.count === 0) throw new HttpError(409, 'already_superseded');
    return { ...fresh, supersedes: { id: old.id, version: old.version } };
  };
  return '$transaction' in db ? db.$transaction((tx) => run(tx)) : run(db);
}

export async function deleteEntry(db: Db, id: string, projectId?: string) {
  const run = async (tx: Db) => {
    const e = await ownEntry(tx, id, projectId);
    await tx.memoryEntry.updateMany({ where: { supersededById: id }, data: { supersededById: null } });
    await tx.memorySource.deleteMany({ where: { memoryEntryId: id } });
    await tx.memoryEntry.delete({ where: { id } });
    return e;
  };
  return '$transaction' in db ? db.$transaction((tx) => run(tx)) : run(db);
}

export function proposedCount(db: Db, projectId: string) {
  return db.memoryEntry.count({ where: { projectId, status: 'proposed', supersededById: null } });
}

export function taskHistory(db: Db, f: { projectId: string; taskId?: string; limit: number }) {
  return db.memoryEntry.findMany({
    where: { projectId: f.projectId, type: 'task_summary', status: 'verified', supersededById: null, ...(f.taskId && { taskId: f.taskId }) },
    orderBy: { createdAt: 'desc' },
    take: f.limit,
  });
}

export function projectDecisions(db: Db, f: { projectId: string; limit: number }) {
  return db.memoryEntry.findMany({
    where: { projectId: f.projectId, type: { in: ['decision', 'api_contract'] }, status: 'verified', supersededById: null },
    orderBy: { createdAt: 'desc' },
    take: f.limit,
  });
}
