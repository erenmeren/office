'use client';

import Link from 'next/link';
import { Kv, KvLabel, KvValue } from '@/components/ui/kv';
import { useConversations, type ContextPack, type TaskRun } from '@/lib/queries';

export const contextPackLine = (p: ContextPack) => `${p.entryIds.length} entries · ${p.summaryIds.length} summaries · ${p.inboxCount} unread`;

/** What the latest run was given (context pack) and the task's conversation, when either exists. */
export function TaskContext({ taskId, projectId, latest }: { taskId: string; projectId: string; latest?: TaskRun }) {
  const conversation = useConversations(projectId).data?.find((c) => c.taskId === taskId);
  const pack = latest?.session?.contextPack;
  if (!pack && !conversation) return null;
  return (
    <div className="flex flex-wrap gap-x-8 gap-y-3">
      {pack && (
        <Kv>
          <KvLabel>Context pack</KvLabel>
          <KvValue>
            <Link href="/memory" className="text-ink-2 underline-offset-4 hover:text-ink hover:underline">
              {contextPackLine(pack)}
            </Link>
          </KvValue>
        </Kv>
      )}
      {conversation && (
        <Kv>
          <KvLabel>Conversation</KvLabel>
          <KvValue>
            <Link href={`/conversations?taskId=${taskId}`} className="text-ink-2 underline-offset-4 hover:text-ink hover:underline">
              Conversation
            </Link>
          </KvValue>
        </Kv>
      )}
    </div>
  );
}
