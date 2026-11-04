'use client';

import { useState } from 'react';
import { cva } from 'class-variance-authority';
import { FolderPlus, Terminal } from 'lucide-react';
import { NewProjectForm } from '@/components/new-project-form';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import type { ClaudeSession, Project } from '@/lib/queries';
import { relativeTime } from '@/lib/workers';

const rowVariants = cva('flex w-full items-center gap-2.5 rounded-xl border px-2.5 py-2 text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50', {
  variants: { active: { true: 'border-violet/50 bg-violet/20', false: 'border-transparent hover:bg-white/7' } },
});

interface Group {
  key: string;
  label: string;
  /** set for an unregistered folder: the path to register */
  folder?: string;
  sessions: ClaudeSession[];
}

/** By project (the selected one first), then by unregistered folder; newest session first within a group. */
export function groupSessions(sessions: ClaudeSession[], projects: Project[], selectedId?: string): Group[] {
  const byProject = new Map<string, ClaudeSession[]>();
  const byFolder = new Map<string, ClaudeSession[]>();
  for (const s of [...sessions].sort((a, b) => b.lastModified - a.lastModified)) {
    const map = s.projectId ? byProject : byFolder;
    const key = s.projectId ?? s.cwd;
    map.set(key, [...(map.get(key) ?? []), s]);
  }
  const ordered = [...projects].sort((a, b) => Number(b.id === selectedId) - Number(a.id === selectedId));
  return [
    ...ordered.filter((p) => byProject.has(p.id)).map((p) => ({ key: p.id, label: p.name, sessions: byProject.get(p.id)! })),
    ...[...byFolder].map(([cwd, list]) => ({ key: cwd, label: cwd, folder: cwd, sessions: list })),
  ];
}

const slugOf = (folder: string) => folder.split('/').filter(Boolean).pop()?.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') ?? '';

/** The machine's Claude Code sessions outside Office, grouped by project or unregistered folder. */
export function ClaudeSessionList({
  sessions,
  projects,
  selectedProjectId,
  selected,
  onSelect,
  error,
}: {
  sessions: ClaudeSession[];
  projects: Project[];
  selectedProjectId?: string;
  selected?: string;
  onSelect: (s: ClaudeSession) => void;
  /** why the list could not be read (no local worker, for one) */
  error?: string;
}) {
  const [registering, setRegistering] = useState<string>();
  const groups = groupSessions(sessions, projects, selectedProjectId);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Terminal className="size-4 text-ink-3" aria-hidden />
          Claude CLI
        </CardTitle>
        <CardDescription>Sessions started from a terminal on this machine. Read-only here; resume them in a terminal.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {error ? (
          <p className="text-[13px] text-ink-3">{error}</p>
        ) : groups.length === 0 ? (
          <p className="text-[13px] text-ink-3">No Claude Code sessions under the workspace roots.</p>
        ) : (
          groups.map((g) => (
            <section key={g.key} aria-label={g.label} className="flex flex-col gap-1">
              <div className="flex items-center gap-2 px-1">
                <span className="min-w-0 flex-1 truncate text-xs font-semibold tracking-[0.04em] uppercase text-ink-3" title={g.label}>
                  {g.folder ? `Unregistered · ${g.label}` : g.label}
                </span>
                {g.folder && (
                  <Button size="xs" variant="ghost" onClick={() => setRegistering(g.folder)} title="Add this folder as an Office project">
                    <FolderPlus aria-hidden /> Add as project
                  </Button>
                )}
              </div>
              <ul className="flex flex-col gap-1">
                {g.sessions.map((s) => (
                  <li key={s.sessionId}>
                    <button type="button" aria-pressed={selected === s.sessionId} className={rowVariants({ active: selected === s.sessionId })} onClick={() => onSelect(s)}>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium text-ink">{s.title || '(untitled)'}</span>
                        <span className="block truncate font-mono text-xs text-ink-3">
                          {s.sessionId.slice(0, 8)}
                          {s.gitBranch && ` · ${s.gitBranch}`} · {relativeTime(new Date(s.lastModified).toISOString())}
                        </span>
                      </span>
                      {s.live && <Badge variant="secondary">{s.live.status === 'busy' ? 'running' : s.live.status}</Badge>}
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))
        )}
      </CardContent>
      <Dialog open={!!registering} onOpenChange={(open) => !open && setRegistering(undefined)}>
        <DialogContent>
          <DialogTitle>Add folder as a project</DialogTitle>
          {registering && (
            <NewProjectForm
              initial={{ name: registering.split('/').filter(Boolean).pop() ?? '', slug: slugOf(registering), repoPath: registering }}
              onDone={() => setRegistering(undefined)}
            />
          )}
        </DialogContent>
      </Dialog>
    </Card>
  );
}
