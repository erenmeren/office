'use client';

import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { MemoryDetail } from '@/components/memory-detail';
import { MemoryForm } from '@/components/memory-form';
import { MemoryList, MemorySearch } from '@/components/memory-list';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { PageActions, PageDescription, PageHeader, PageTitle } from '@/components/ui/page-header';
import { matchesType, type TypeFilter } from '@/lib/memory';
import { useAgents, useMemory, useMemoryCounts, useProjects, type MemoryEntry } from '@/lib/queries';
import { useMounted } from '@/lib/use-mounted';
import { uiSocket } from '@/lib/ws';

function MemoryView() {
  const mounted = useMounted();
  const qc = useQueryClient();
  const router = useRouter();
  const params = useSearchParams();
  const project = useProjects().data?.[0];
  const agents = useAgents().data ?? [];
  const [q, setQ] = useState('');
  const [type, setType] = useState<TypeFilter>('all');
  const [reviewing, setReviewing] = useState(false);
  const [form, setForm] = useState<{ entry?: MemoryEntry } | undefined>();
  const list = useMemory(project?.id, { q, status: reviewing ? 'proposed' : undefined });
  const total = useMemory(project?.id).data?.length ?? 0;
  const proposed = useMemoryCounts(project?.id).data?.proposed ?? 0;
  const taskId = params.get('taskId');
  const entries = (list.data ?? []).filter((e) => matchesType(e, type) && (!taskId || e.taskId === taskId));
  const selectedId = params.get('id') ?? entries[0]?.id;
  const select = (id?: string, task = taskId) => {
    const qs = new URLSearchParams();
    if (id) qs.set('id', id);
    if (task) qs.set('taskId', task);
    router.replace(qs.size ? `/memory?${qs}` : '/memory');
  };

  useEffect(
    () =>
      uiSocket().subscribe('global', 0, (m) => {
        if (m.type === 'memory.changed') void qc.invalidateQueries({ queryKey: ['memory'] });
      }),
    [qc],
  );

  if (!mounted) return null;

  return (
    <div className="space-y-5">
      <PageHeader>
        <div>
          <PageTitle>Project Memory</PageTitle>
          <PageDescription>
            Curated knowledge for {project?.name ?? 'your project'}. Every entry keeps its sources, and nothing generated becomes a fact until it is verified.
          </PageDescription>
        </div>
        <PageActions>
          <Button size="lg" onClick={() => setForm({})}>
            Add memory
          </Button>
        </PageActions>
      </PageHeader>

      {form && project && (
        <MemoryForm
          key={form.entry?.id ?? 'new'}
          projectId={project.id}
          entry={form.entry}
          onCancel={() => setForm(undefined)}
          onDone={(id) => {
            setForm(undefined);
            select(id);
          }}
        />
      )}

      <Card>
        <CardContent>
          <MemorySearch q={q} onQ={setQ} type={type} onType={setType} proposed={proposed} reviewing={reviewing} onReview={setReviewing} />
          {taskId && (
            <Button variant="secondary" size="sm" className="mt-3 font-mono" aria-label={`Task ${taskId.slice(0, 8)}, clear filter`} onClick={() => select(undefined, null)}>
              Task {taskId.slice(0, 8)}
              <X data-icon="inline-end" aria-hidden />
            </Button>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="flex flex-wrap gap-5">
          <div className="min-w-0 flex-[2_1_320px]">
            <MemoryList entries={entries} total={total} searching={!!q.trim()} agents={agents} selectedId={selectedId} onSelect={select} />
          </div>
          <div className="min-w-0 flex-[3_1_480px]">
            {selectedId && project ? (
              <MemoryDetail key={selectedId} projectId={project.id} id={selectedId} onEdit={(entry) => setForm({ entry })} onDeleted={() => select()} />
            ) : (
              <p className="text-sm text-ink-3">{list.isPending ? 'Loading…' : 'Pick an entry or add one.'}</p>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

export default function MemoryPage() {
  return (
    <Suspense>
      <MemoryView />
    </Suspense>
  );
}
