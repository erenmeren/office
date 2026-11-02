'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { Fragment, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { AgentForm, type AgentFormBody } from '@/components/agent-form';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api } from '@/lib/api';
import { useProject } from '@/lib/project';
import { useAgent, useLiveSessions } from '@/lib/queries';

export default function AgentPage() {
  const { id } = useParams<{ id: string }>();
  const qc = useQueryClient();
  const agent = useAgent(id);
  const project = useProject();
  const liveRun = useLiveSessions(project?.id).data?.find((s) => s.agentId === id);
  const [open, setOpen] = useState<string | null>(null);

  const save = async (body: AgentFormBody) => {
    await api(`/agents/${id}`, { method: 'PUT', body: JSON.stringify(body) });
    await qc.invalidateQueries({ queryKey: ['agent', id] });
    await qc.invalidateQueries({ queryKey: ['agents'] });
  };

  if (agent.isPending) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (agent.isError) return <p className="text-sm text-destructive">{String(agent.error)}</p>;
  const a = agent.data;
  const versions = [...a.versions].reverse();

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <h1 className="text-xl font-semibold">{a.name}</h1>
        <span className="font-mono text-sm text-muted-foreground">{a.slug}</span>
        <Badge variant="outline">{a.isActive ? 'active' : 'inactive'}</Badge>
        {a.currentVersion && <Badge variant="secondary">v{a.currentVersion.version}</Badge>}
        {liveRun && (
          <Button variant="secondary" size="sm" nativeButton={false} render={<Link href={`/sessions/${liveRun.runId}`} />}>
            Inspect live session
          </Button>
        )}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Edit</CardTitle>
        </CardHeader>
        <CardContent>
          {a.currentVersion ? (
            // keyed by version so a save remounts the form with the new version's values
            <AgentForm
              key={a.currentVersion.id}
              initial={{ name: a.name, slug: a.slug, role: a.role, description: a.description, isActive: a.isActive, version: a.currentVersion }}
              submitLabel="Save as new version"
              onSubmit={save}
            />
          ) : (
            <p className="text-sm text-muted-foreground">No version.</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Versions</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Version</TableHead>
                <TableHead>Created</TableHead>
                <TableHead>Model</TableHead>
                <TableHead>Skills</TableHead>
                <TableHead>Subagents</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {versions.map((v) => (
                <Fragment key={v.id}>
                  <TableRow className="cursor-pointer" onClick={() => setOpen(open === v.id ? null : v.id)}>
                    <TableCell>v{v.version}</TableCell>
                    <TableCell>{new Date(v.createdAt).toLocaleString()}</TableCell>
                    <TableCell>{v.config.model}</TableCell>
                    <TableCell className="space-x-1">
                      {v.skills.map((s) => (
                        <Badge key={s.skillId} variant="secondary" className="font-mono">
                          {s.name}@{s.version} ({s.mode})
                        </Badge>
                      ))}
                    </TableCell>
                    <TableCell className="font-mono">{v.subagents.map((s) => s.name).join(', ')}</TableCell>
                  </TableRow>
                  {open === v.id && (
                    <TableRow>
                      <TableCell colSpan={5}>
                        <pre className="overflow-x-auto whitespace-pre-wrap bg-muted/30 p-2 text-xs">{JSON.stringify(v, null, 2)}</pre>
                      </TableCell>
                    </TableRow>
                  )}
                </Fragment>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
