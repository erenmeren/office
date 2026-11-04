'use client';

import { useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { del, put } from '@/lib/api';
import { selectProject } from '@/lib/project';
import type { Project } from '@/lib/queries';
import { useConfirm } from '@/components/ui/confirm-dialog';

/** The project's own fields (name, default branch) and its deletion; the repository path is fixed at creation. */
export function ProjectCard({ project }: { project: Project }) {
  const qc = useQueryClient();
  const [name, setName] = useState(project.name);
  const [defaultBranch, setDefaultBranch] = useState(project.defaultBranch);
  const [error, setError] = useState('');
  const dirty = name !== project.name || defaultBranch !== project.defaultBranch;
  const refresh = () => qc.invalidateQueries({ queryKey: ['projects'] });
  const save = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await put(`/projects/${project.id}`, { name, defaultBranch });
      await refresh();
    } catch (err) {
      setError(String(err));
    }
  };
  const confirm = useConfirm();
  const remove = async () => {
    if (!(await confirm({ title: `Delete project "${project.name}"?`, body: 'Its missions, tasks, runs, sessions and memory are deleted too. The repository on disk is kept.', confirmLabel: 'Delete', destructive: true }))) return;
    try {
      await del(`/projects/${project.id}`);
      selectProject('');
      await refresh();
    } catch (err) {
      setError(String(err).includes('project_in_use') ? 'A mission or a run of this project is still live; cancel it first.' : String(err));
    }
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle>Project</CardTitle>
        <CardDescription>Repository: {project.repoPath}</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={save} className="flex flex-wrap items-end gap-3">
          <Field label="Name" htmlFor="project-name" className="w-64">
            <Input id="project-name" required value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Default branch" htmlFor="project-default-branch" className="w-40">
            <Input id="project-default-branch" required value={defaultBranch} onChange={(e) => setDefaultBranch(e.target.value)} />
          </Field>
          <Button type="submit" variant="secondary" disabled={!dirty}>
            Save project
          </Button>
          <Button type="button" variant="destructive" onClick={remove}>
            Delete project
          </Button>
          {error && (
            <p role="alert" className="w-full text-sm text-destructive">
              {error}
            </p>
          )}
        </form>
      </CardContent>
    </Card>
  );
}
