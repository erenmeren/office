'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { post } from '@/lib/api';
import { useProject } from '@/lib/project';
import { useAgents, useProjects, type Task } from '@/lib/queries';

function Pick(props: { label: string; value: string; onChange: (v: string) => void; items: { value: string; label: string }[] }) {
  return (
    <div className="space-y-1">
      <Label>{props.label}</Label>
      <Select items={props.items} value={props.value} onValueChange={(v) => props.onChange(String(v ?? ''))}>
        <SelectTrigger className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {props.items.map((i) => (
            <SelectItem key={i.value} value={i.value}>
              {i.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

export default function NewTaskPage() {
  const router = useRouter();
  const projects = useProjects();
  const agents = useAgents();
  const current = useProject();
  const [picked, setPicked] = useState<string>();
  const projectId = picked ?? current?.id ?? '';
  const [agentId, setAgentId] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState('');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!projectId || !agentId) return setError('Pick a project and an agent');
    try {
      const task = await post<Task>('/tasks', { projectId, agentId, title, description });
      router.push(`/tasks/${task.id}`);
    } catch (err) {
      setError(String(err));
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>New task</CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        <form onSubmit={submit} className="space-y-4">
          <Pick
            label="Project"
            value={projectId}
            onChange={setPicked}
            items={(projects.data ?? []).map((p) => ({ value: p.id, label: `${p.name} (${p.repoPath})` }))}
          />
          <Pick
            label="Agent"
            value={agentId}
            onChange={setAgentId}
            items={(agents.data ?? []).map((a) => ({ value: a.id, label: `${a.name} (${a.role})` }))}
          />
          <div className="space-y-1">
            <Label htmlFor="title">Title</Label>
            <Input id="title" required value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="description">Description</Label>
            <Textarea id="description" rows={6} value={description} onChange={(e) => setDescription(e.target.value)} />
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <Button type="submit">Create task</Button>
        </form>
      </CardContent>
    </Card>
  );
}
