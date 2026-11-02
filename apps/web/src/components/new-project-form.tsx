'use client';

import { useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { post } from '@/lib/api';
import { selectProject } from '@/lib/project';
import type { Project } from '@/lib/queries';

const FIELDS = [
  { key: 'name', label: 'Name' },
  { key: 'slug', label: 'Slug' },
  { key: 'repoPath', label: 'Repository path', placeholder: 'empty: a new repository is created' },
] as const;

/** Creates a project and selects it. An empty repository path asks the API for a new repository (greenfield). */
export function NewProjectForm({ onDone }: { onDone: () => void }) {
  const qc = useQueryClient();
  const [form, setForm] = useState({ name: '', slug: '', repoPath: '' });
  const [error, setError] = useState('');
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const project = await post<Project>('/projects', { ...form, repoPath: form.repoPath.trim() || undefined });
      await qc.invalidateQueries({ queryKey: ['projects'] });
      selectProject(project.id);
      onDone();
    } catch (err) {
      setError(String(err));
    }
  };
  return (
    <Card size="sm" className="w-[360px]">
      <CardHeader>
        <CardTitle>New project</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="space-y-3">
          {FIELDS.map((f) => (
            <div key={f.key} className="space-y-1">
              <Label htmlFor={`project-${f.key}`}>{f.label}</Label>
              <Input
                id={`project-${f.key}`}
                required={f.key !== 'repoPath'}
                placeholder={'placeholder' in f ? f.placeholder : undefined}
                value={form[f.key]}
                onChange={(e) => setForm({ ...form, [f.key]: e.target.value })}
              />
            </div>
          ))}
          {error && <p className="text-sm text-destructive">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={onDone}>
              Cancel
            </Button>
            <Button type="submit" size="sm">
              Create
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
