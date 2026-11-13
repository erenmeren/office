'use client';

import { useState } from 'react';
import { ArrowUp, FolderGit2, Folder } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { useBrowse } from '@/lib/queries';

/**
 * Picks a folder on the machine the API runs on (your home, the data directory, the workers' roots), or names a new
 * one inside the folder shown: that path is picked, and whoever takes it makes the folder (`POST /projects` does).
 */
export function FolderPicker({ open, onOpenChange, initial, onPick }: { open: boolean; onOpenChange: (open: boolean) => void; initial?: string; onPick: (path: string) => void }) {
  const [path, setPath] = useState<string | undefined>(initial || undefined);
  const [name, setName] = useState('');
  const fresh = name.trim();
  const q = useBrowse(path, open);
  const d = q.data;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogTitle>Choose a folder</DialogTitle>
        <div className="flex items-center gap-2">
          <Button size="xs" variant="ghost" disabled={!d?.parent} onClick={() => setPath(d?.parent ?? undefined)} aria-label="Up one folder">
            <ArrowUp aria-hidden />
          </Button>
          <span className="min-w-0 flex-1 truncate font-mono text-xs text-ink-2" title={d?.path}>{d?.path ?? '…'}</span>
          {d?.isRepo && <span className="text-[11px] text-ink-3">git repository</span>}
        </div>
        {q.isError && <p className="text-sm text-destructive">This folder cannot be browsed here.</p>}
        <ul aria-label="Folders" className="max-h-72 overflow-auto rounded-lg border border-white/10">
          {d?.dirs.length === 0 && <li className="px-3 py-2 text-[13px] text-ink-3">No subfolders.</li>}
          {d?.dirs.map((f) => (
            <li key={f.path}>
              <button type="button" className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-white/7" onClick={() => setPath(f.path)}>
                {f.isRepo ? <FolderGit2 className="size-4 text-ink-3" aria-hidden /> : <Folder className="size-4 text-ink-3" aria-hidden />}
                <span className="truncate">{f.name}</span>
              </button>
            </li>
          ))}
        </ul>
        <Input aria-label="New folder name" placeholder="Or type a name to make a new folder here" value={name} onChange={(e) => setName(e.target.value)} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button type="button" size="sm" disabled={!d} onClick={() => { onPick(fresh ? `${d!.path}/${fresh}` : d!.path); setName(''); onOpenChange(false); }}>
            {fresh ? 'Make new folder' : 'Use this folder'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
