'use client';

import { AgentAvatar } from '@/components/ui/agent-avatar';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { StatusPill } from '@/components/ui/status-pill';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { usd } from '@/lib/dashboard';
import { useAgents, useOverview, useProjects } from '@/lib/queries';

/** Who is doing what right now, with today's spend per agent. */
export function DashboardTeam() {
  const o = useOverview(useProjects().data?.[0]?.id).data;
  const agents = useAgents().data;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Team</CardTitle>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Agent</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Current work</TableHead>
              <TableHead className="text-right">Cost</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {o?.team.map((m) => (
              <TableRow key={m.agentId}>
                <TableCell>
                  <div className="flex items-center gap-2.5">
                    <AgentAvatar name={m.name} identity={agents?.find((a) => a.id === m.agentId)?.slug} size="md" />
                    <div className="min-w-0">
                      <div className="font-medium text-ink">{m.name}</div>
                      <div className="text-xs text-ink-3">{m.role}</div>
                    </div>
                  </div>
                </TableCell>
                <TableCell>
                  <StatusPill status={m.status === 'needs_approval' ? 'waiting_approval' : m.status} />
                </TableCell>
                <TableCell>
                  <div className="text-ink">{m.currentWork ?? 'No assigned work'}</div>
                  <div className="font-mono text-xs text-ink-3">{m.workerName ?? 'no session'}</div>
                </TableCell>
                <TableCell className="text-right font-mono">{usd(m.costTodayUsd)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
