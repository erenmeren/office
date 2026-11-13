'use client';

import { FolderOpen } from 'lucide-react';
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { FolderPicker } from '@/components/folder-picker';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { ApiError, post } from '@/lib/api';
import { selectProject } from '@/lib/project';
import { useProjects, type Project } from '@/lib/queries';

/**
 * Opens a folder of this computer as a project: pick it, and it gets a tab named after the folder (the tab can be
 * renamed). A folder that is a project already only gets its tab back.
 */
export function OpenFolder({ variant = 'ghost' }: { variant?: 'ghost' | 'secondary' }) {
  const qc = useQueryClient();
  const projects = useProjects().data;
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState('');
  const open = async (path: string) => {
    const known = projects?.find((p) => p.repoPath === path);
    if (known) return selectProject(known.id);
    try {
      const project = await post<Project>('/projects', { name: path.split('/').filter(Boolean).pop() ?? path, repoPath: path });
      await qc.invalidateQueries({ queryKey: ['projects'] });
      selectProject(project.id);
    } catch (err) {
      const body = err instanceof ApiError ? (err.body as { message?: string; error?: string } | undefined) : undefined;
      setError(body?.message ?? body?.error ?? String(err));
    }
  };
  return (
    <>
      <Button variant={variant} size="sm" aria-label="Open folder…" onClick={() => setPicking(true)}>
        <FolderOpen data-icon="inline-start" aria-hidden />
        <span className={variant === 'ghost' ? 'hidden sm:inline' : undefined}>Open folder…</span>
      </Button>
      <FolderPicker open={picking} onOpenChange={setPicking} onPick={(path) => void open(path)} />
      <Dialog open={!!error} onOpenChange={() => setError('')}>
        <DialogContent>
          <DialogTitle>This folder cannot be opened</DialogTitle>
          <p className="text-sm text-ink-2">{error}</p>
        </DialogContent>
      </Dialog>
    </>
  );
}
