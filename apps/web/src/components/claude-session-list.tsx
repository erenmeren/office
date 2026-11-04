'use client';

import { useState } from 'react';
import { cva } from 'class-variance-authority';
import { FolderPlus, Plus, Terminal } from 'lucide-react';
import { NewProjectForm } from '@/components/new-project-form';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { SearchInput } from '@/components/ui/search-input';
import { Segmented } from '@/components/ui/segmented';
import { isSessionRunning, type ClaudeSession, type Project, type TerminalView } from '@/lib/queries';
import { relativeTime } from '@/lib/workers';

const rowVariants = cva('flex w-full items-center gap-2.5 rounded-xl border px-2.5 py-2 text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50', {
  variants: { active: { true: 'border-violet/50 bg-violet/20', false: 'border-transparent hover:bg-white/7' } },
});

export type CliFilter = 'all' | 'running' | 'manual' | 'external' | 'background';
const FILTERS: { value: CliFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'running', label: 'Running' },
  { value: 'manual', label: 'Manual' },
  { value: 'external', label: 'External' },
  { value: 'background', label: 'Background' },
];

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

/** The badge text for a session a process holds: `running`, or a background session's state. */
export const liveLabel = (s: ClaudeSession) => (s.live ? (s.live.kind === 'background' ? `bg · ${s.live.state ?? 'running'}` : 'running') : undefined);

const matchesSearch = (q: string, ...fields: (string | undefined)[]) => !q || fields.some((f) => f?.toLowerCase().includes(q));
const matchesFilter = (f: CliFilter, s: ClaudeSession) =>
  f === 'all' || (f === 'running' ? isSessionRunning(s) : f === 'external' ? !s.live || s.live.kind !== 'background' : f === 'background' ? s.live?.kind === 'background' : false);

/** The machine's Claude Code sessions outside Office's agents: manual ones in Office terminals, external and background ones read-only. */
export function ClaudeSessionList({
  sessions,
  terminals,
  projects,
  selectedProjectId,
  selected,
  onSelect,
  onSelectTerminal,
  onNewTerminal,
  onNewBackground,
  error,
}: {
  sessions: ClaudeSession[];
  /** Office-managed manual sessions, newest first */
  terminals: TerminalView[];
  projects: Project[];
  selectedProjectId?: string;
  selected?: string;
  onSelect: (s: ClaudeSession) => void;
  onSelectTerminal: (t: TerminalView) => void;
  /** starts a manual session on the selected project; absent when no project is selected */
  onNewTerminal?: () => void;
  /** starts a background session (`claude --bg`) on the selected project with a prompt */
  onNewBackground?: (prompt: string) => Promise<void>;
  /** why the list could not be read (no local worker, for one) */
  error?: string;
}) {
  const [registering, setRegistering] = useState<string>();
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<CliFilter>('all');
  const [bgOpen, setBgOpen] = useState(false);
  const [bgPrompt, setBgPrompt] = useState('');
  const [bgError, setBgError] = useState('');
  const [bgBusy, setBgBusy] = useState(false);
  const q = query.trim().toLowerCase();
  const manyWorkers = new Set(sessions.map((s) => s.workerId)).size > 1;
  const shownTerminals = filter === 'all' || filter === 'manual' || filter === 'running'
    ? terminals.filter((t) => (filter !== 'running' || t.status !== 'exited') && matchesSearch(q, t.claudeSessionId, t.dir, projects.find((p) => p.id === t.projectId)?.name))
    : [];
  const shownSessions = filter === 'manual' ? [] : sessions.filter((s) => matchesFilter(filter, s) && matchesSearch(q, s.title, s.sessionId, s.gitBranch, s.cwd, s.live?.name));
  const groups = groupSessions(shownSessions, projects, selectedProjectId);
  const startBackground = async () => {
    setBgBusy(true);
    setBgError('');
    try {
      await onNewBackground!(bgPrompt.trim());
      setBgOpen(false);
      setBgPrompt('');
    } catch (err) {
      setBgError(String(err));
    } finally {
      setBgBusy(false);
    }
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Terminal className="size-4 text-ink-3" aria-hidden />
          Claude CLI
        </CardTitle>
        <CardDescription>Your own Claude Code sessions on this machine: manual ones run inside Office, external and background ones read-only.</CardDescription>
        {onNewTerminal && (
          <CardAction className="flex gap-1">
            <Button size="sm" variant="secondary" onClick={onNewTerminal} title="Start your own Claude Code in this project, inside Office">
              <Plus aria-hidden /> New manual session
            </Button>
            {onNewBackground && (
              <Button size="sm" variant="ghost" onClick={() => setBgOpen(true)} title="claude --bg: runs a prompt in the background; attach to it any time">
                Background…
              </Button>
            )}
          </CardAction>
        )}
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <SearchInput aria-label="Search sessions" placeholder="Search title, id, branch, folder" value={query} onChange={(e) => setQuery(e.target.value)} />
        <Segmented label="Filter Claude sessions" options={FILTERS} value={filter} onChange={setFilter} />
        {error && <p className="text-[13px] text-ink-3">{error}</p>}
        {shownTerminals.length > 0 && (
          <section aria-label="Manual sessions" className="flex flex-col gap-1">
            <span className="px-1 text-xs font-semibold tracking-[0.04em] uppercase text-ink-3">Manual sessions in Office</span>
            <ul className="flex flex-col gap-1">
              {shownTerminals.map((t) => (
                <li key={t.id}>
                  <button type="button" aria-pressed={selected === t.id} className={rowVariants({ active: selected === t.id })} onClick={() => onSelectTerminal(t)}>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium text-ink">{projects.find((p) => p.id === t.projectId)?.name ?? t.dir}</span>
                      <span className="block truncate font-mono text-xs text-ink-3">
                        {t.attachId ? `attached ${t.attachId}` : t.claudeSessionId.slice(0, 8)}{t.forked ? ' · fork' : t.resumedSessionId ? ' · resumed' : ''} · {relativeTime(t.startedAt)}
                      </span>
                    </span>
                    <Badge variant={t.status === 'exited' ? 'outline' : 'secondary'}>{t.status}</Badge>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
        {!error && groups.length === 0 && shownTerminals.length === 0 && (
          <p className="text-[13px] text-ink-3">{sessions.length || terminals.length ? 'No session matches.' : 'No Claude Code sessions under the workspace roots.'}</p>
        )}
        {groups.map((g) => (
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
                <li key={`${s.workerId}:${s.sessionId}`}>
                  <button type="button" aria-pressed={selected === s.sessionId} className={rowVariants({ active: selected === s.sessionId })} onClick={() => onSelect(s)}>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium text-ink">{s.title || '(untitled)'}</span>
                      <span className="block truncate font-mono text-xs text-ink-3">
                        {s.sessionId.slice(0, 8)}
                        {s.gitBranch && ` · ${s.gitBranch}`} · {relativeTime(new Date(s.lastModified).toISOString())}
                        {manyWorkers && ` · ${s.workerName}`}
                      </span>
                    </span>
                    {s.live && <Badge variant={isSessionRunning(s) ? 'secondary' : 'outline'}>{liveLabel(s)}</Badge>}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}
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
      <Dialog open={bgOpen} onOpenChange={setBgOpen}>
        <DialogContent>
          <DialogTitle>New background session</DialogTitle>
          <p className="text-sm text-ink-2">Runs <code className="font-mono text-xs">claude --bg</code> with this prompt in the project folder. It works on its own; attach from the list to watch or steer it.</p>
          <textarea
            aria-label="Prompt"
            className="min-h-28 w-full rounded-lg border border-white/13 bg-black/30 p-2 font-mono text-xs text-ink outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
            value={bgPrompt}
            onChange={(e) => setBgPrompt(e.target.value)}
          />
          {bgError && <p className="text-sm text-destructive">{bgError}</p>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => setBgOpen(false)}>Cancel</Button>
            <Button type="button" size="sm" disabled={!bgPrompt.trim() || bgBusy} onClick={startBackground}>{bgBusy ? 'Starting…' : 'Start'}</Button>
          </div>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
