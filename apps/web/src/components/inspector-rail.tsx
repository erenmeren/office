'use client';

import Link from 'next/link';
import { ApprovalCard } from '@/components/approval-card';
import { subagentName } from '@/components/session-list';
import { AgentAvatar } from '@/components/ui/agent-avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { DashboardStack } from '@/components/ui/kpi-card';
import { StatusPill } from '@/components/ui/status-pill';
import type { SessionDetail } from '@/lib/queries';
import { clockTime, elapsed } from '@/lib/sessions';

/** Right rail: the task, a pending approval, the subagents and the skills of one session. */
export function InspectorRail({ detail: d }: { detail: SessionDetail }) {
  const shortId = (d.sessionId ?? d.runId).slice(0, 8);
  return (
    <DashboardStack>
      {d.taskId && (
        <Card>
          <CardHeader>
            <CardTitle>Current task</CardTitle>
            <CardDescription className="flex flex-wrap items-center gap-2">
              {d.taskKey && <span className="font-mono text-xs">{d.taskKey}</span>}
              <span className="text-ink">{d.taskTitle}</span>
            </CardDescription>
          </CardHeader>
          <CardContent>
            <StatusPill status={d.status} />
          </CardContent>
          <CardFooter>
            <Button variant="secondary" size="sm" nativeButton={false} render={<Link href={`/tasks/${d.taskId}`} />}>
              Open task
            </Button>
          </CardFooter>
        </Card>
      )}

      {d.approval && <ApprovalCard approval={d.approval} agentName={d.agentName} title="Waiting for you" />}

      <Card>
        <CardHeader>
          <CardTitle>Subagents</CardTitle>
          <CardDescription>Native Claude Code subagents of {shortId}. Depth 1 of 1.</CardDescription>
        </CardHeader>
        <CardContent>
          {d.subagents.length === 0 ? (
            <p className="text-[13px] text-ink-3">No subagents in this session.</p>
          ) : (
            <ul aria-label="Subagents of this session" className="flex flex-col gap-3">
              {d.subagents.map((s) => (
                <li key={s.id} className="flex items-start gap-2.5">
                  <AgentAvatar name={subagentName(s)} subagent size="md" />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-ink">{subagentName(s)}</span>
                      <StatusPill status={s.status} />
                    </div>
                    {s.description && <p className="truncate text-[13px] text-ink-2">{s.description}</p>}
                    <p className="font-mono text-xs text-ink-3">
                      {s.id.slice(0, 8)} · {s.endedAt ? elapsed(Date.parse(s.endedAt) - Date.parse(s.startedAt)) : `started ${clockTime(s.startedAt)}`}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Skills in this session</CardTitle>
          <CardDescription>Exact versions materialized when the session started.</CardDescription>
        </CardHeader>
        <CardContent>
          {d.skills.length === 0 ? (
            <p className="text-[13px] text-ink-3">No skills pinned.</p>
          ) : (
            <ul aria-label="Skills in this session" className="flex flex-col gap-2">
              {d.skills.map((s) => (
                <li key={s.skillVersionId} className="flex items-center justify-between gap-2">
                  <span className="truncate font-mono text-[13px] text-ink">
                    {s.name} <span className="text-ink-3">v{s.version}</span>
                  </span>
                  <Badge variant={s.mode === 'eager' ? 'secondary' : 'outline'}>{s.mode === 'eager' ? 'Eager' : 'On demand'}</Badge>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </DashboardStack>
  );
}
