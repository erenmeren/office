'use client';

import { useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Copy, ExternalLink, Play } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Kv, KvLabel, KvValue } from '@/components/ui/kv';
import { ApiError, post } from '@/lib/api';
import { fetchTranscript, type ClaudeSession, type TerminalView } from '@/lib/queries';

const when = (ms?: number) => (ms ? new Date(ms).toLocaleString() : '—');

/** Read-only transcript of an external Claude Code session, with a way to resume it in a terminal. */
/** `onResumed` receives the Office terminal that now runs this session. */
export function ClaudeSessionDetail({ session: s, onResumed }: { session: ClaudeSession; onResumed: (t: TerminalView) => void }) {
  const [note, setNote] = useState('');
  const command = `cd ${s.cwd} && claude --resume ${s.sessionId}`;
  const q = useInfiniteQuery({
    queryKey: ['claude-transcript', s.sessionId],
    queryFn: ({ pageParam }) => fetchTranscript(s.sessionId, s.cwd, pageParam),
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
      const { terminal } = await post<{ terminal: string }>(`/claude-sessions/${s.sessionId}/open`, { dir: s.cwd });
      setNote(`Opened in ${terminal}.`);
    } catch (err) {
      const code = err instanceof ApiError ? (err.body as { error?: string; message?: string }) : undefined;
      setNote(code?.error === 'session_live' ? 'This session is still running in another terminal.' : `Could not open a terminal${code?.message ? `: ${code.message}` : ''}. Copy the command instead.`);
    }
  };
  const copy = () => navigator.clipboard.writeText(command).then(() => setNote('Command copied.'), () => setNote(command));
  const resumeHere = async () => {
    setNote('');
    try {
      onResumed(await post<TerminalView>('/terminals', { dir: s.cwd, resumeSessionId: s.sessionId }));
    } catch (err) {
      const body = err instanceof ApiError ? (err.body as { error?: string; message?: string }) : undefined;
      setNote(body?.error === 'session_live' ? 'This session is still running in another terminal.' : `Could not start it here${body?.message ? `: ${body.message}` : ''}.`);
    }
  };

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center gap-2.5">
            <span className="font-heading text-lg text-ink">{s.title || '(untitled)'}</span>
            <Badge variant="outline">external</Badge>
            {s.live && <Badge variant="secondary">{s.live.status === 'busy' ? 'running' : s.live.status} · pid {s.live.pid}</Badge>}
          </CardTitle>
          <CardDescription className="font-mono text-xs">{s.sessionId}</CardDescription>
          <CardAction className="flex gap-2">
            <Button size="sm" variant="default" onClick={resumeHere} disabled={!!s.live} title={s.live ? 'Still running in another terminal; resuming it twice is not safe.' : 'Continue this conversation in a terminal inside Office'}>
              <Play aria-hidden /> Resume here
            </Button>
            <Button size="sm" variant="secondary" onClick={open} disabled={!!s.live} title={s.live ? 'Still running in another terminal; resuming it twice is not safe.' : 'Open a terminal with claude --resume'}>
              <ExternalLink aria-hidden /> Open in terminal
            </Button>
            <Button size="sm" variant="ghost" onClick={copy} title={command}>
              <Copy aria-hidden /> Copy command
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Kv className="col-span-2"><KvLabel>Folder</KvLabel><KvValue className="font-mono break-all">{s.cwd}</KvValue></Kv>
          <Kv><KvLabel>Branch</KvLabel><KvValue className="font-mono">{s.gitBranch ?? '—'}</KvValue></Kv>
          <Kv><KvLabel>Last activity</KvLabel><KvValue>{when(s.lastModified)}</KvValue></Kv>
          <Kv><KvLabel>Started</KvLabel><KvValue>{when(s.createdAt)}</KvValue></Kv>
          {note && <p className="col-span-2 text-[13px] text-ink-2 sm:col-span-3" role="status">{note}</p>}
        </CardContent>
      </Card>

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
