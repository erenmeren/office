'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { post } from '@/lib/api';
import { useAgents, useProjects, type Project, type Task } from '@/lib/queries';

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

// no project page in phase 1: a project must exist before a task can be created
function NewProject() {
  const qc = useQueryClient();
  const [form, setForm] = useState({ name: '', slug: '', repoPath: '' });
  const [error, setError] = useState('');
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      // an empty repoPath asks the API to create a new repository (greenfield project)
      await post<Project>('/projects', { ...form, repoPath: form.repoPath.trim() || undefined });
      setForm({ name: '', slug: '', repoPath: '' });
      await qc.invalidateQueries({ queryKey: ['projects'] });
    } catch (err) {
      setError(String(err));
    }
  };
  return (
    <form onSubmit={submit} className="flex flex-wrap items-end gap-2">
      {(['name', 'slug', 'repoPath'] as const).map((k) => (
        <div key={k} className="space-y-1">
          <Label htmlFor={`project-${k}`}>Project {k}</Label>
          <Input
            id={`project-${k}`}
            required={k !== 'repoPath'}
            placeholder={k === 'repoPath' ? 'empty: new repository' : undefined}
            value={form[k]}
            onChange={(e) => setForm({ ...form, [k]: e.target.value })}
          />
        </div>
      ))}
      <Button type="submit" variant="secondary">
        Add project
      </Button>
      {error && <p className="w-full text-sm text-destructive">{error}</p>}
    </form>
  );
}

export default function NewTaskPage() {
  const router = useRouter();
  const projects = useProjects();
  const agents = useAgents();
  const [projectId, setProjectId] = useState('');
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
        <NewProject />
        <form onSubmit={submit} className="space-y-4">
          <Pick
            label="Project"
            value={projectId}
            onChange={setProjectId}
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
