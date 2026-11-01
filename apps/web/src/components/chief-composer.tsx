'use client';

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { FolderGit2, Send, Wallet } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { post } from '@/lib/api';
import type { Agent, Project, Task } from '@/lib/queries';

function Chip({ icon: Icon, children }: { icon: typeof FolderGit2; children: React.ReactNode }) {
  return (
    <span className="inline-flex h-9 items-center gap-2 rounded-[10px] border border-white/22 bg-white/10 px-3 text-sm">
      <Icon className="size-3.5 text-ink-3" aria-hidden />
      {children}
    </span>
  );
}

/** "Request to Chief": the first line becomes the task title, the whole text its description. */
export function ChiefComposer({ project, chief, onCreated }: { project?: Project; chief?: Agent; onCreated: (task: Task) => void }) {
  const qc = useQueryClient();
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const budget = chief?.currentVersion?.config.maxBudgetUsd;

  const send = async () => {
    if (!project || !chief) return;
    setBusy(true);
    setError('');
    try {
      const title = text.trim().split('\n')[0].slice(0, 120);
      const task = await post<Task>('/tasks', { projectId: project.id, agentId: chief.id, title, description: text.trim() });
      setText('');
      await qc.invalidateQueries({ queryKey: ['tasks'] });
      onCreated(task);
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardContent className="space-y-3">
        <Label htmlFor="chief-request" className="text-[12.5px] text-ink-2">
          Request to Chief
        </Label>
        <Textarea
          id="chief-request"
          rows={3}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Describe the outcome you want."
          className="min-h-[86px] rounded-[10px] bg-[rgb(7_5_24/0.55)] px-3.5 py-3 text-base leading-6 shadow-[inset_0_1px_3px_rgba(0,0,0,.35)]"
        />
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <Chip icon={FolderGit2}>{project?.name ?? 'No project'}</Chip>
            {budget !== undefined && <Chip icon={Wallet}>Budget cap ${budget.toFixed(2)}</Chip>}
          </div>
          <Button size="lg" onClick={send} disabled={busy || !text.trim() || !project || !chief}>
            <Send data-icon="inline-start" aria-hidden />
            Send to Chief
          </Button>
        </div>
        {!chief && <p className="text-sm text-amber">No agent with slug `chief`. Run `pnpm seed` or create one in Agent Studio.</p>}
        {error && <p className="text-sm text-destructive">{error}</p>}
      </CardContent>
    </Card>
  );
}
