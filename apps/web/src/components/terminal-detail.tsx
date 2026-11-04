'use client';

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Square } from 'lucide-react';
import { OfficeTerminal } from '@/components/office-terminal';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { Kv, KvLabel, KvValue } from '@/components/ui/kv';
import { del } from '@/lib/api';
import type { TerminalView } from '@/lib/queries';

/** A manual session the owner runs inside Office: the live terminal, where it runs, and a way to stop it. */
export function TerminalDetail({ terminal: t, onGone }: { terminal: TerminalView; onGone: () => void }) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [error, setError] = useState('');
  const live = t.status !== 'exited';
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
          <CardDescription className="font-mono text-xs">{t.claudeSessionId}{t.resumedSessionId ? ' (resumed)' : ''}</CardDescription>
          <CardAction>
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
      <Card>
        <CardHeader>
          <CardTitle>Terminal</CardTitle>
          <CardDescription>Your own Claude Code, with your CLAUDE.md, plugins and skills. Office adds nothing and approves nothing here.</CardDescription>
        </CardHeader>
        <CardContent>
          <OfficeTerminal key={t.id} terminalId={t.id} live={live} />
        </CardContent>
      </Card>
    </div>
  );
}
