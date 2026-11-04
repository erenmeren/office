'use client';

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { Copy, Maximize2, Minimize2, ScrollText, Square } from 'lucide-react';
import { OfficeTerminal } from '@/components/office-terminal';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { Kv, KvLabel, KvValue } from '@/components/ui/kv';
import { del } from '@/lib/api';
import type { Mission, TerminalView } from '@/lib/queries';

/** A manual session the owner runs inside Office: the live terminal, where it runs, and a way to stop it. */
export function TerminalDetail({ terminal: t, onGone, mission }: { terminal: TerminalView; onGone: () => void; mission?: Mission }) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [error, setError] = useState('');
  const [full, setFull] = useState(false);
  const [copied, setCopied] = useState(false);
  const live = t.status !== 'exited';
  const handoff = mission && `Mission "${mission.title}" (${mission.status}${mission.branch ? `, branch ${mission.branch}` : ''}):\n${mission.summary ?? mission.request}`;
  const copyHandoff = () => navigator.clipboard.writeText(handoff!).then(() => setCopied(true));
  const stop = async () => {
    if (live && !(await confirm({ title: 'Stop this session?', body: 'The Claude process gets SIGHUP, like closing its terminal window. The conversation stays resumable.', confirmLabel: 'Stop', destructive: true }))) return;
    try {
      await del(`/terminals/${t.id}`);
      await qc.invalidateQueries({ queryKey: ['terminals'] });
      if (!live) onGone();
    } catch (err) {
      setError(String(err));
    }
  };
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center gap-2.5">
            <span className="font-heading text-lg text-ink">Manual session</span>
            <Badge variant="outline">office</Badge>
            <Badge variant="secondary">{t.status}{t.pid ? ` · pid ${t.pid}` : ''}{t.status === 'exited' && t.exitCode !== undefined && t.exitCode !== null ? ` · exit ${t.exitCode}` : ''}</Badge>
          </CardTitle>
          <CardDescription className="font-mono text-xs">
            {t.attachId ? `attached to background ${t.attachId} · ` : ''}{t.claudeSessionId}{t.forked ? ` (fork of ${t.resumedSessionId?.slice(0, 8)})` : t.resumedSessionId ? ' (resumed)' : ''}
          </CardDescription>
          <CardAction className="flex gap-2">
            {!t.attachId && (
              <Button size="sm" variant="ghost" nativeButton={false} render={<Link href={`/sessions?session=${t.claudeSessionId}`} />} title="The transcript as Claude saved it (after the first exchange)">
                <ScrollText aria-hidden /> Transcript
              </Button>
            )}
            <Button size="sm" variant={live ? 'destructive' : 'ghost'} onClick={stop}>
              <Square aria-hidden /> {live ? 'Stop' : 'Dismiss'}
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Kv className="col-span-2"><KvLabel>Folder</KvLabel><KvValue className="font-mono break-all">{t.dir}</KvValue></Kv>
          <Kv><KvLabel>Started</KvLabel><KvValue>{new Date(t.startedAt).toLocaleString()}</KvValue></Kv>
          <Kv><KvLabel>Ended</KvLabel><KvValue>{t.exitedAt ? new Date(t.exitedAt).toLocaleString() : '—'}</KvValue></Kv>
          {error && <p className="col-span-full text-sm text-destructive">{error}</p>}
        </CardContent>
      </Card>
      {mission && (
        <Card>
          <CardHeader>
            <CardTitle>From mission: {mission.title}</CardTitle>
            <CardDescription>
              {mission.branch ? `The mission's work is on ${mission.branch}; this terminal is on the checkout's current branch. ` : ''}
              Paste the summary into Claude to pick up where the team stopped.
            </CardDescription>
            <CardAction>
              <Button size="sm" variant="secondary" onClick={copyHandoff}>
                <Copy aria-hidden /> {copied ? 'Copied' : 'Copy summary'}
              </Button>
            </CardAction>
          </CardHeader>
          <CardContent>
            <p className="text-sm whitespace-pre-wrap text-ink-2">{mission.summary ?? mission.request}</p>
          </CardContent>
        </Card>
      )}
      <Card className={full ? 'fixed inset-2 z-50 flex flex-col' : undefined}>
        <CardHeader>
          <CardTitle>Terminal</CardTitle>
          <CardDescription>Your own Claude Code, with your CLAUDE.md, plugins and skills. Office adds nothing and approves nothing here. Ctrl+Shift+C copies, Ctrl+Shift+V pastes, Ctrl+Shift+F searches.</CardDescription>
          <CardAction>
            <Button size="sm" variant="ghost" onClick={() => setFull((f) => !f)} aria-pressed={full} title={full ? 'Back to the page' : 'Fill the window'}>
              {full ? <Minimize2 aria-hidden /> : <Maximize2 aria-hidden />} {full ? 'Exit full screen' : 'Full screen'}
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent className={full ? 'min-h-0 flex-1' : undefined}>
          <OfficeTerminal key={t.id} terminalId={t.id} live={live} className={full ? 'h-full' : undefined} />
        </CardContent>
      </Card>
    </div>
  );
}
