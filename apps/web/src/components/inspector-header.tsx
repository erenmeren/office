'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { MessageSquare } from 'lucide-react';
import { StopButton } from '@/components/session-detail';
import { AgentAvatar } from '@/components/ui/agent-avatar';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { KpiCard } from '@/components/ui/kpi-card';
import { StatusPill } from '@/components/ui/status-pill';
import { post } from '@/lib/api';
import { usd } from '@/lib/dashboard';
import { useAgent, type Conversation, type SessionDetail } from '@/lib/queries';
import { clockTime, elapsed, isLive, kTokens } from '@/lib/sessions';

/** Who the session is, what it has spent, and the owner's two actions on it. */
export function InspectorHeader({ detail: d, onCancelled }: { detail: SessionDetail; onCancelled: () => void }) {
  const router = useRouter();
  const role = useAgent(d.agentId).data?.role;
  const live = isLive(d.status);
  const [now, setNow] = useState(() => Date.now());
  const [error, setError] = useState('');
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [live]);

  const { inputTokens: inT, outputTokens: outT } = d.usage;
  const end = live ? now : d.finishedAt ? Date.parse(d.finishedAt) : undefined;
  const ran = d.startedAt && end !== undefined ? end - Date.parse(d.startedAt) : undefined;

  const message = async () => {
    setError('');
    try {
      const conv = await post<Conversation>('/conversations', { projectId: d.projectId, kind: 'human', agentIds: [d.agentId] });
      router.push(`/conversations?id=${conv.id}`);
    } catch (err) {
      setError(String(err));
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2.5">
          <AgentAvatar name={d.agentName} size="lg" />
          <span className="font-heading text-xl text-ink">{d.agentName}</span>
          <StatusPill status={d.status} />
        </CardTitle>
        <CardDescription className="flex flex-wrap gap-x-3 font-mono text-xs">
          {role && <span className="font-sans">{role}</span>}
          {d.model && <span>{d.model}</span>}
          <span>config v{d.agentVersion}</span>
          {d.workerName && <span>{d.workerName}</span>}
          <span title={d.sessionId ?? d.runId}>{(d.sessionId ?? d.runId).slice(0, 8)}</span>
        </CardDescription>
        <CardAction className="flex flex-wrap items-center gap-2">
          {error && <span role="alert" className="text-xs text-destructive">{error}</span>}
          <Button variant="secondary" onClick={() => void message()}>
            <MessageSquare data-icon="inline-start" aria-hidden />
            Message
          </Button>
          {live && <StopButton runId={d.runId} name={d.agentName} subagent={false} onCancelled={onCancelled} label="Stop session" />}
        </CardAction>
      </CardHeader>
      <CardContent className="grid gap-3 sm:grid-cols-3">
        <KpiCard label="Tokens" value={kTokens(inT + outT)} sub={`${kTokens(inT)} in · ${kTokens(outT)} out`} />
        <KpiCard label="Session cost" value={usd(d.costUsd)} sub={d.maxBudgetUsd === null ? undefined : `cap ${usd(d.maxBudgetUsd)}`} />
        <KpiCard
          label={live ? 'Running for' : 'Ran for'}
          value={ran === undefined ? '—' : elapsed(ran)}
          sub={d.startedAt ? `since ${clockTime(d.startedAt)}` : undefined}
        />
      </CardContent>
    </Card>
  );
}
