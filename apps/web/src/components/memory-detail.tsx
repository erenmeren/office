'use client';

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Author } from '@/components/memory-list';
import { Button } from '@/components/ui/button';
import { Kv, KvLabel, KvValue } from '@/components/ui/kv';
import { MemoryStatusTag, TypeTag } from '@/components/ui/type-tag';
import { del, post } from '@/lib/api';
import { sourceLabel } from '@/lib/memory';
import { useAgents, useMemoryEntry, type MemoryEntry } from '@/lib/queries';

export function MemoryDetail({
  projectId,
  id,
  onEdit,
  onDeleted,
}: {
  projectId: string;
  id: string;
  onEdit: (entry: MemoryEntry) => void;
  onDeleted: () => void;
}) {
  const qc = useQueryClient();
  const agents = useAgents().data ?? [];
  const entry = useMemoryEntry(id, projectId);
  const [error, setError] = useState('');

  if (entry.isPending) return <p className="text-sm text-ink-3">Loading…</p>;
  if (entry.isError) return <p className="text-sm text-destructive">{String(entry.error)}</p>;
  const e = entry.data;

  const act = async (run: () => Promise<unknown>, after?: () => void) => {
    setError('');
    try {
      await run();
      await qc.invalidateQueries({ queryKey: ['memory'] });
      after?.();
    } catch (err) {
      setError(String(err));
    }
  };
  const remove = () => {
    if (window.confirm(`Delete "${e.title}"?`)) void act(() => del(`/memory/${e.id}`), onDeleted);
  };

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <TypeTag type={e.type} />
          <MemoryStatusTag status={e.status} label={e.status === 'verified' ? 'Verified by you' : undefined} />
        </div>
        <h2 className="font-heading text-xl leading-[26px] font-semibold">{e.title}</h2>
        <p className="max-w-prose text-sm whitespace-pre-wrap text-ink-2">{e.content}</p>
        <div className="flex items-center gap-2 text-xs text-ink-2">
          <Author entry={e} agents={agents} />
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        {e.status === 'proposed' && (
          <>
            <Button onClick={() => void act(() => post(`/memory/${e.id}/verify`))}>Verify</Button>
            <Button variant="destructive" onClick={() => void act(() => post(`/memory/${e.id}/reject`))}>
              Reject
            </Button>
          </>
        )}
        <Button variant="secondary" onClick={() => onEdit(e)}>
          Edit
        </Button>
        <Button variant="destructive" onClick={remove}>
          Delete
        </Button>
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}

      <Kv>
        <KvLabel>Where this came from</KvLabel>
        {e.sources.length === 0 ? (
          <p className="text-sm text-ink-3">No sources recorded.</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {e.sources.map((s) => (
              <li key={s.id} className="flex items-baseline gap-2 text-[13px]">
                <span className="w-16 shrink-0 text-xs text-ink-3 capitalize">{s.kind}</span>
                <span className="min-w-0 break-words font-mono text-ink-2">{sourceLabel(s)}</span>
              </li>
            ))}
          </ul>
        )}
      </Kv>

      <Kv>
        <KvLabel>Revisions</KvLabel>
        <ul className="flex flex-col gap-1">
          {[{ id: e.id, version: e.version, title: e.title, createdAt: e.updatedAt }, ...e.revisions].map((r) => (
            <li key={r.id} className="flex items-baseline justify-between gap-2 text-[13px]">
              <KvValue className="min-w-0 break-words">
                v{r.version} · {r.title}
              </KvValue>
              <span className="shrink-0 font-mono text-xs text-ink-3">{new Date(r.createdAt).toLocaleString()}</span>
            </li>
          ))}
        </ul>
      </Kv>

      <p className="text-xs text-ink-3">Kept until superseded.</p>
    </div>
  );
}
