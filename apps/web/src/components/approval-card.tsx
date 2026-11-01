'use client';

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ShieldAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Countdown } from '@/components/ui/countdown';
import { post } from '@/lib/api';
import { approvalSentence, approvalTypeLabel } from '@/lib/missions';
import type { ApprovalView } from '@/lib/queries';

/** What the agent asked to do: the Bash command, the file path, or the gate's reason. */
function subject(a: ApprovalView): string {
  const input = (a.input ?? {}) as { command?: unknown; file_path?: unknown };
  if (typeof input.command === 'string') return input.command;
  if (typeof input.file_path === 'string') return input.file_path;
  return a.reason;
}

/** A pending tool or budget approval: the paused session waits for the owner's decision. */
export function ApprovalCard({ approval, agentName, title = 'Approval required' }: { approval: ApprovalView; agentName: string; title?: string }) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const decide = async (path: string, body?: unknown) => {
    setBusy(true);
    setError('');
    try {
      await post(`/approvals/${approval.id}/${path}`, body);
      await Promise.all(['approvals', 'missions', 'session'].map((k) => qc.invalidateQueries({ queryKey: [k] })));
    } catch (err) {
      setError(String(err));
      // e.g. 409 already_decided: refetch so a stale card disappears
      void qc.invalidateQueries({ queryKey: ['approvals'] });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="border-amber/45 shadow-[0_0_0_3px_rgba(255,194,71,.18),0_0_30px_rgba(255,194,71,.18)]">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ShieldAlert className="size-4 text-amber" aria-hidden />
          {title}
        </CardTitle>
        <CardDescription className="text-ink-2">{approvalSentence(approval, agentName)}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <pre className="overflow-x-auto rounded-[10px] border border-white/13 bg-[rgb(7_5_24/0.55)] px-3.5 py-2.5 font-mono text-[13px] whitespace-pre-wrap break-all text-ink">
          {subject(approval)}
        </pre>
        <div className="flex flex-wrap gap-2">
          <Button disabled={busy} onClick={() => decide('approve', { scope: 'once' })}>
            Approve once
          </Button>
          {approval.type !== 'budget_exceeded' && (
            <Button variant="secondary" disabled={busy} onClick={() => decide('approve', { scope: 'task' })}>
              Approve for this task
            </Button>
          )}
          <Button variant="destructive" disabled={busy} onClick={() => decide('deny')}>
            Deny
          </Button>
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
      </CardContent>
      <CardFooter className="text-[12.5px] text-ink-3">
        Policy: {approvalTypeLabel(approval.type)} ask first
        {approval.expiresAt && (
          <>
            {' · auto-deny in '}
            <Countdown expiresAt={approval.expiresAt} />
          </>
        )}
      </CardFooter>
    </Card>
  );
}
