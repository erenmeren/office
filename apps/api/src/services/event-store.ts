import type { Prisma, PrismaClient } from '@office/db';
import type { OfficeEvent } from '@office/shared';
import { redactSecrets } from '@office/runtime';
import type { EventHub } from './event-hub.js';

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * Persists one event with its payload redacted. A repeated (sessionId, seq) is a no-op.
 * With a hub, a newly stored event is published on `run:<runId>` and `project:<projectId>`.
 */
export async function appendEvent(prisma: Db, event: OfficeEvent, hub?: EventHub): Promise<{ inserted: boolean }> {
  try {
    await prisma.sessionEvent.create({
      data: {
        sessionId: event.sessionId,
        seq: event.seq,
        type: event.type,
        ts: new Date(event.ts),
        payload: redactSecrets(event.payload) as Prisma.InputJsonObject,
      },
    });
    hub?.publish(`run:${event.runId}`, event);
    hub?.publish(`project:${event.projectId}`, event);
    return { inserted: true };
  } catch (err) {
    if ((err as { code?: string }).code === 'P2002') return { inserted: false };
    throw err;
  }
}

export async function listEvents(
  prisma: Db,
  sessionId: string,
  afterSeq = 0,
  limit = 1000,
): Promise<OfficeEvent[]> {
  const session = await prisma.agentSession.findUnique({ where: { id: sessionId } });
  if (!session) return [];
  const rows = await prisma.sessionEvent.findMany({
    where: { sessionId, seq: { gt: afterSeq } },
    orderBy: { seq: 'asc' },
    take: limit,
  });
  return rows.map((r) => ({
    type: r.type as OfficeEvent['type'],
    seq: r.seq,
    ts: r.ts.toISOString(),
    sessionId,
    runId: session.runId,
    agentId: session.agentId,
    projectId: session.projectId,
    payload: r.payload as Record<string, unknown>,
  }));
}
