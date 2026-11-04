'use client';

import { useState } from 'react';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { Copy, ExternalLink, FileText, GitFork, Pencil, Play, Rocket, Square, Trash2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { Kv, KvLabel, KvValue } from '@/components/ui/kv';
import { ApiError, del, post } from '@/lib/api';
import { fetchTranscript, isSessionRunning, type ClaudeSession, type TerminalView } from '@/lib/queries';
import { liveLabel } from '@/components/claude-session-list';
import { draftFromTranscript, saveMissionDraft } from '@/lib/mission-draft';

const when = (ms?: number) => (ms ? new Date(ms).toLocaleString() : '—');
const describe = (err: unknown, fallback: string) => {
  const body = err instanceof ApiError ? (err.body as { error?: string; message?: string }) : undefined;
  if (body?.error === 'session_live') return 'This session is still running in another process.';
  return `${fallback}${body?.message ? `: ${body.message}` : ''}.`;
};

/** Read-only transcript of an external or background Claude Code session, with ways to continue it. `onResumed` gets the Office terminal. */
export function ClaudeSessionDetail({ session: s, onResumed, onDeleted }: { session: ClaudeSession; onResumed: (t: TerminalView) => void; onDeleted: () => void }) {
  const [note, setNote] = useState('');
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState(s.title);
  const [logs, setLogs] = useState<string>();
  const confirm = useConfirm();
  const qc = useQueryClient();
  const router = useRouter();
  const running = isSessionRunning(s);
  const background = s.live?.kind === 'background';
  const command = `cd ${s.cwd} && claude --resume ${s.sessionId}`;
  const q = useInfiniteQuery({
    queryKey: ['claude-transcript', s.workerId, s.sessionId],
    queryFn: ({ pageParam }) => fetchTranscript(s.sessionId, s.cwd, pageParam, s.workerId),
    initialPageParam: 0,
    getNextPageParam: (last) => last.nextOffset ?? undefined,
    retry: false,
  });
  const entries = q.data?.pages.flatMap((p) => p.entries) ?? [];
  const loading = q.isFetching;
  const error = q.error ? (q.error instanceof ApiError ? `Could not read the transcript (${(q.error.body as { error?: string })?.error ?? q.error.status}).` : String(q.error)) : '';

  const open = async () => {
    setNote('');
    try {
      const { terminal } = await post<{ terminal: string }>(`/claude-sessions/${s.sessionId}/open`, { dir: s.cwd, workerId: s.workerId });
      setNote(`Opened in ${terminal}.`);
    } catch (err) {
      setNote(`${describe(err, 'Could not open a terminal')} Copy the command instead.`);
    }
  };
  const copy = () => navigator.clipboard.writeText(command).then(() => setNote('Command copied.'), () => setNote(command));
  const inOffice = async (body: object, what: string) => {
    setNote('');
    try {
      onResumed(await post<TerminalView>('/terminals', { dir: s.cwd, workerId: s.workerId, ...body }));
    } catch (err) {
      setNote(describe(err, `Could not ${what}`));
    }
  };
  // handoff to the Chief: the transcript becomes a draft request the owner edits before sending; the session itself is untouched
  const startMission = () => {
    saveMissionDraft(draftFromTranscript(s, entries));
    router.push('/mission-control');
  };
  const rename = async () => {
    setNote('');
    try {
      await post(`/claude-sessions/${s.sessionId}/rename`, { dir: s.cwd, title: title.trim(), workerId: s.workerId });
      setRenaming(false);
      await qc.invalidateQueries({ queryKey: ['claude-sessions'] });
    } catch (err) {
      setNote(describe(err, 'Could not rename it'));
    }
  };
  const remove = async () => {
    if (!(await confirm({ title: 'Delete this session?', body: 'The transcript Claude saved is deleted from disk. This cannot be undone.', confirmLabel: 'Delete', destructive: true }))) return;
    setNote('');
    try {
      await del(`/claude-sessions/${s.sessionId}?dir=${encodeURIComponent(s.cwd)}&workerId=${s.workerId}`);
      await qc.invalidateQueries({ queryKey: ['claude-sessions'] });
      onDeleted();
    } catch (err) {
      setNote(describe(err, 'Could not delete it'));
    }
  };
  const showLogs = async () => {
    setNote('');
    try {
      const r = await post<{ output: string }>(`/claude-sessions/background/${s.live!.id}/logs`, { workerId: s.workerId });
      setLogs(r.output || '(no output yet)');
    } catch (err) {
      setNote(describe(err, 'Could not read its logs'));
    }
  };
  const backgroundAction = async (action: 'stop' | 'rm') => {
    if (action === 'rm' && !(await confirm({ title: 'Remove this background session?', body: 'claude rm deletes the session and its worktree.', confirmLabel: 'Remove', destructive: true }))) return;
    setNote('');
    try {
      const r = await post<{ output: string }>(`/claude-sessions/background/${s.live!.id}/${action}`, { workerId: s.workerId });
      setNote(r.output.trim().split('\n')[0] ?? 'Done.');
      await qc.invalidateQueries({ queryKey: ['claude-sessions'] });
    } catch (err) {
      setNote(describe(err, action === 'stop' ? 'Could not stop it' : 'Could not remove it'));
    }
  };

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center gap-2.5">
            <span className="font-heading text-lg text-ink">{s.title || '(untitled)'}</span>
            <Badge variant="outline">{background ? 'background' : 'external'}</Badge>
            {s.live && <Badge variant={running ? 'secondary' : 'outline'}>{liveLabel(s)}{s.live.pid ? ` · pid ${s.live.pid}` : ''}</Badge>}
          </CardTitle>
          <CardDescription className="font-mono text-xs">{s.sessionId}{s.live?.id ? ` · ${s.live.id}` : ''}</CardDescription>
          <CardAction className="flex flex-wrap gap-2">
            {background && running && s.live?.id ? (
              <>
                <Button size="sm" variant="default" onClick={() => inOffice({ attachId: s.live!.id }, 'attach')} title="claude attach: watch and steer it in a terminal inside Office">
                  <Play aria-hidden /> Attach here
                </Button>
                <Button size="sm" variant="secondary" onClick={() => backgroundAction('stop')} title="claude stop: the conversation is kept">
                  <Square aria-hidden /> Stop
                </Button>
              </>
            ) : (
              <>
                <Button size="sm" variant="default" onClick={() => inOffice({ resumeSessionId: s.sessionId }, 'resume it here')} disabled={running} title={running ? 'Still running elsewhere; resuming it twice is not safe. Fork instead.' : 'Continue this conversation in a terminal inside Office'}>
                  <Play aria-hidden /> Resume here
                </Button>
                <Button size="sm" variant="secondary" onClick={() => inOffice({ resumeSessionId: s.sessionId, fork: true }, 'fork it')} title="Continue in a copy: a new session, the original stays as it is">
                  <GitFork aria-hidden /> Fork here
                </Button>
                {s.local && (
                  <Button size="sm" variant="secondary" onClick={open} disabled={running} title={running ? 'Still running in another terminal.' : 'Open a terminal emulator with claude --resume'}>
                    <ExternalLink aria-hidden /> Open in terminal
                  </Button>
                )}
              </>
            )}
            {background && s.live?.id && (
              <>
                <Button size="sm" variant="ghost" onClick={showLogs} title="claude logs: the session's recent screen, as text">
                  <FileText aria-hidden /> Logs
                </Button>
                <Button size="sm" variant="ghost" onClick={() => backgroundAction('rm')} title="claude rm: delete the session and its worktree">
                  <Trash2 aria-hidden /> Remove
                </Button>
              </>
            )}
            <Button size="sm" variant="ghost" onClick={() => setRenaming(true)} title="Set the title Claude shows for this session">
              <Pencil aria-hidden /> Rename
            </Button>
            {!background && (
              <Button size="sm" variant="ghost" onClick={remove} disabled={running} title={running ? 'Still running; stop it first.' : 'Delete the saved transcript'}>
                <Trash2 aria-hidden /> Delete
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={copy} title={command}>
              <Copy aria-hidden /> Copy command
            </Button>
            <Button size="sm" variant="ghost" onClick={startMission} disabled={entries.length === 0} title="Draft a request to the Chief from this conversation; you edit it before it is sent">
              <Rocket aria-hidden /> Start a mission from this
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Kv className="col-span-2"><KvLabel>Folder</KvLabel><KvValue className="font-mono break-all">{s.cwd}</KvValue></Kv>
          <Kv><KvLabel>Branch</KvLabel><KvValue className="font-mono">{s.gitBranch ?? '—'}</KvValue></Kv>
          <Kv><KvLabel>Worker</KvLabel><KvValue>{s.workerName}</KvValue></Kv>
          <Kv><KvLabel>Last activity</KvLabel><KvValue>{when(s.lastModified)}</KvValue></Kv>
          <Kv><KvLabel>Started</KvLabel><KvValue>{when(s.createdAt)}</KvValue></Kv>
          {note && <p className="col-span-2 text-[13px] text-ink-2" role="status">{note}</p>}
        </CardContent>
      </Card>

      {logs !== undefined && (
        <Card>
          <CardHeader>
            <CardTitle>Recent screen</CardTitle>
            <CardDescription>What the background session last drew, without colours. Attach to watch it live.</CardDescription>
            <CardAction>
              <Button size="xs" variant="ghost" onClick={() => setLogs(undefined)}>Close</Button>
            </CardAction>
          </CardHeader>
          <CardContent>
            <pre className="max-h-96 overflow-auto rounded-lg bg-black/40 p-3 font-mono text-xs whitespace-pre-wrap text-ink-2">{logs}</pre>
          </CardContent>
        </Card>
      )}
      <Dialog open={renaming} onOpenChange={setRenaming}>
        <DialogContent>
          <DialogTitle>Rename session</DialogTitle>
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              void rename();
            }}
          >
            <Input aria-label="Title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} required />
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" size="sm" onClick={() => setRenaming(false)}>Cancel</Button>
              <Button type="submit" size="sm" disabled={!title.trim()}>Save</Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      <Card>
        <CardHeader>
          <CardTitle>Transcript</CardTitle>
          <CardDescription>Read-only. Tool calls show by name; results and thinking are left out.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {error && <p className="text-sm text-destructive">{error}</p>}
          {entries.length === 0 && !loading && !error && <p className="text-[13px] text-ink-3">No messages.</p>}
          <ol aria-label="Transcript" className="flex flex-col gap-3">
            {entries.map((e) => (
              <li key={e.uuid} className={e.role === 'user' ? 'flex flex-row-reverse' : 'flex'}>
                <div className={`max-w-[min(100%,640px)] rounded-2xl border px-3.5 py-2.5 text-sm leading-[22px] ${e.role === 'user' ? 'border-pink/35 bg-pink/12' : 'border-white/13 bg-white/7'}`}>
                  {e.text && <p className="whitespace-pre-wrap break-words">{e.text}</p>}
                  {e.tools.length > 0 && (
                    <p className="mt-1 flex flex-wrap gap-1">
                      {e.tools.map((t, i) => (
                        <Badge key={`${t}-${i}`} variant="outline">{t}</Badge>
                      ))}
                    </p>
                  )}
                </div>
              </li>
            ))}
          </ol>
          {q.hasNextPage && (
            <Button size="sm" variant="ghost" className="self-center" disabled={loading} onClick={() => void q.fetchNextPage()}>
              {loading ? 'Loading…' : 'Load more'}
            </Button>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
