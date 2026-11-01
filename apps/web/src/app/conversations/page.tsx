'use client';

import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { ConversationList, type Filter } from '@/components/conversation-list';
import { ConversationSide, MessageThread } from '@/components/message-thread';
import { NewConversation } from '@/components/new-conversation';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { PageActions, PageDescription, PageHeader, PageTitle } from '@/components/ui/page-header';
import { useMounted } from '@/lib/use-mounted';
import { uiSocket } from '@/lib/ws';
import { useAgents, useConversation, useConversations, useProjects } from '@/lib/queries';

function ConversationsView() {
  const mounted = useMounted();
  const qc = useQueryClient();
  const router = useRouter();
  const params = useSearchParams();
  const project = useProjects().data?.[0];
  const agents = useAgents().data ?? [];
  const [filter, setFilter] = useState<Filter>('all');
  const [panel, setPanel] = useState<'human' | 'group'>();
  const list = useConversations(project?.id, filter === 'all' ? undefined : filter);
  const all = list.data ?? [];
  const unfiltered = useConversations(project?.id).data ?? [];

  const byTask = params.get('taskId');
  // A task link never falls back to an unrelated conversation.
  const selectedId = params.get('id') ?? (byTask ? unfiltered.find((c) => c.taskId === byTask)?.id : all[0]?.id);
  const open = useConversation(selectedId);
  const select = (id: string) => router.replace(`/conversations?id=${id}`);

  // Messages are not run events: no replay, so just refetch on every one.
  useEffect(() => {
    const refresh = (m: { type: string }) => {
      if (m.type !== 'message.created') return;
      void qc.invalidateQueries({ queryKey: ['conversations'] });
      void qc.invalidateQueries({ queryKey: ['conversation'] });
    };
    const topics = ['global', ...(selectedId ? [`conversation:${selectedId}`] : [])];
    const offs = topics.map((t) => uiSocket().subscribe(t, 0, refresh));
    return () => offs.forEach((off) => off());
  }, [qc, selectedId]);

  if (!mounted) return null;

  return (
    <div className="space-y-5">
      <PageHeader>
        <div>
          <PageTitle>Conversations</PageTitle>
          <PageDescription>Every message is saved before delivery. Agents talk to each other directly, and you can join any thread.</PageDescription>
        </div>
        <PageActions>
          <Button variant="secondary" size="lg" onClick={() => setPanel('group')}>
            New group
          </Button>
          <Button size="lg" onClick={() => setPanel('human')}>
            Message an agent
          </Button>
        </PageActions>
      </PageHeader>

      {panel && project && (
        <NewConversation
          key={panel}
          mode={panel}
          projectId={project.id}
          agents={agents}
          onCancel={() => setPanel(undefined)}
          onCreated={(c) => {
            setPanel(undefined);
            select(c.id);
          }}
        />
      )}

      <Card>
        <CardContent className="flex flex-wrap gap-5">
          <div className="min-w-0 flex-[2_1_320px]">
            <ConversationList
              projectId={project?.id}
              conversations={all}
              agents={agents}
              selectedId={selectedId}
              filter={filter}
              onFilter={setFilter}
              onSelect={select}
            />
          </div>
          <div className="min-w-0 flex-[3_1_480px]">
            {open.data ? (
              <div className="flex flex-wrap gap-5">
                <div className="min-w-0 flex-[3_1_360px]">
                  <MessageThread key={open.data.id} conversation={open.data} agents={agents} />
                </div>
                <div className="min-w-0 flex-[1_1_200px]">
                  <ConversationSide conversation={open.data} agents={agents} />
                </div>
              </div>
            ) : (
              <p className="text-sm text-ink-3">{list.isPending ? 'Loading…' : byTask && !params.get('id') ? 'No conversation for this task yet.' : 'Pick a conversation or start one.'}</p>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

export default function ConversationsPage() {
  return (
    <Suspense>
      <ConversationsView />
    </Suspense>
  );
}
