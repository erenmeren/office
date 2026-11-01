'use client';

import Link from 'next/link';
import { AgentAvatar } from '@/components/ui/agent-avatar';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { StatusPill } from '@/components/ui/status-pill';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { TagList } from '@/components/ui/tag-list';
import { useAgents } from '@/lib/queries';

export function AgentsTable() {
  const agents = useAgents();
  return (
    <Card>
      <CardHeader>
        <CardTitle>Team</CardTitle>
        <CardDescription>Every agent is a Claude Code session with the tools, skills and limits of its current version.</CardDescription>
      </CardHeader>
      <CardContent>
        {agents.isPending && <p className="text-sm text-muted-foreground">Loading agents…</p>}
        {agents.isError && <p className="text-sm text-destructive">{String(agents.error)}</p>}
        {agents.isSuccess && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Agent</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Model</TableHead>
                <TableHead>Version</TableHead>
                <TableHead>Skills</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {agents.data.map((a) => (
                <TableRow key={a.id}>
                  <TableCell>
                    <Link href={`/agents/${a.id}`} className="flex items-center gap-2.5">
                      <AgentAvatar name={a.name} identity={a.slug} size="md" />
                      <span className="flex flex-col">
                        <span className="font-medium text-ink">{a.name}</span>
                        <span className="font-mono text-xs text-ink-3">{a.slug}</span>
                      </span>
                    </Link>
                  </TableCell>
                  <TableCell className="text-ink-2">{a.role}</TableCell>
                  <TableCell>
                    <StatusPill status={a.isActive ? 'active' : 'inactive'} tone={a.isActive ? 'live' : 'idle'} />
                  </TableCell>
                  <TableCell>{a.currentVersion ? <Badge variant="outline">{a.currentVersion.config.model}</Badge> : '—'}</TableCell>
                  <TableCell className="font-mono text-ink-2">{a.currentVersion ? `v${a.currentVersion.version}` : '—'}</TableCell>
                  <TableCell>
                    <TagList tags={a.currentVersion?.skills.map((s) => `${s.name}@${s.version}`) ?? []} />
                  </TableCell>
                </TableRow>
              ))}
              {agents.data.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="text-muted-foreground">
                    No agents yet.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
