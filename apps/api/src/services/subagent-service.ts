import type { PrismaClient } from '@office/db';
import type { OfficeEvent } from '@office/shared';

const str = (v: unknown) => (typeof v === 'string' ? v : undefined);

/** Projects `agent.subagent.*` events onto SubagentRun rows; other events are ignored. */
export async function recordSubagentEvent(prisma: PrismaClient, event: OfficeEvent): Promise<void> {
  const p = event.payload;
  const toolUseId = str(p.toolUseId);
  if (!toolUseId) return;
  if (event.type === 'agent.subagent.spawned') {
    await prisma.subagentRun.upsert({
      where: { toolUseId },
      create: {
        sessionId: event.sessionId,
        toolUseId,
        subagentType: str(p.subagentType),
        description: str(p.description),
        status: 'running',
        startedAt: new Date(event.ts),
      },
      // a resent spawn must not reset a completed run
      update: {},
    });
  } else if (event.type === 'agent.subagent.completed') {
    await prisma.subagentRun.updateMany({
      where: { toolUseId },
      data: { status: str(p.status), summary: str(p.summary), endedAt: new Date(event.ts) },
    });
  }
}
