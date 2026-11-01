'use client';

import { useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { Textarea } from '@/components/ui/textarea';
import { post, put } from '@/lib/api';
import type { MemoryEntry } from '@/lib/queries';

const TYPES: MemoryEntry['type'][] = ['decision', 'convention', 'api_contract', 'known_issue', 'lesson'];
const FORM_LABEL: Record<MemoryEntry['type'], string> = {
  decision: 'Decision',
  convention: 'Convention',
  api_contract: 'API contract',
  known_issue: 'Known issue',
  lesson: 'Lesson',
  task_summary: 'Task history',
};

/** Create (`POST /memory`) or, with `entry`, edit (`PUT`, which makes the next version). */
export function MemoryForm({ projectId, entry, onDone, onCancel }: { projectId: string; entry?: MemoryEntry; onDone: (id: string) => void; onCancel: () => void }) {
  const qc = useQueryClient();
  const [type, setType] = useState<MemoryEntry['type']>(entry?.type ?? 'decision');
  const [title, setTitle] = useState(entry?.title ?? '');
  const [content, setContent] = useState(entry?.content ?? '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const body = { title: title.trim(), content: content.trim(), type };
      const saved = entry
        ? await put<MemoryEntry>(`/memory/${entry.id}`, body)
        : await post<MemoryEntry>('/memory', { projectId, scope: 'project', ...body });
      await qc.invalidateQueries({ queryKey: ['memory'] });
      onDone(saved.id);
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{entry ? 'Edit memory' : 'Add memory'}</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="flex flex-col gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="memory-type">Type</Label>
            <NativeSelect id="memory-type" value={type} onChange={(e) => setType(e.target.value as MemoryEntry['type'])}>
              {(TYPES.includes(type) ? TYPES : [...TYPES, type]).map((t) => (
                <option key={t} value={t}>
                  {FORM_LABEL[t]}
                </option>
              ))}
            </NativeSelect>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="memory-title">Title</Label>
            <Input id="memory-title" value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="memory-content">Content</Label>
            <Textarea id="memory-content" rows={5} value={content} onChange={(e) => setContent(e.target.value)} />
          </div>
          <div className="flex gap-2">
            <Button type="submit" disabled={busy || !title.trim() || !content.trim()}>
              {entry ? 'Save new version' : 'Save memory'}
            </Button>
            <Button type="button" variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </form>
      </CardContent>
    </Card>
  );
}
