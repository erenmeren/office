'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { AgentForm, type AgentFormBody } from '@/components/agent-form';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { post } from '@/lib/api';
import { useAgents } from '@/lib/queries';

export default function AgentsPage() {
  const qc = useQueryClient();
  const agents = useAgents();
  const [formKey, setFormKey] = useState(0);

  const create = async (body: AgentFormBody) => {
    await post('/agents', body);
    setFormKey((k) => k + 1); // remount resets the form
    await qc.invalidateQueries({ queryKey: ['agents'] });
  };

  return (
    <div className="space-y-4">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Slug</TableHead>
            <TableHead>Role</TableHead>
            <TableHead>Version</TableHead>
            <TableHead>Model</TableHead>
            <TableHead>Skills</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {agents.data?.map((a) => (
            <TableRow key={a.id}>
              <TableCell>
                <Link href={`/agents/${a.id}`} className="underline">
                  {a.name}
                </Link>
              </TableCell>
              <TableCell className="font-mono">{a.slug}</TableCell>
              <TableCell>{a.role}</TableCell>
              <TableCell>{a.currentVersion?.version ?? '—'}</TableCell>
              <TableCell>{a.currentVersion?.config.model ?? '—'}</TableCell>
              <TableCell className="space-x-1">
                {a.currentVersion?.skills.map((s) => (
                  <Badge key={s.skillId} variant="secondary" className="font-mono">
                    {s.name}@{s.version}
                  </Badge>
                ))}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      <Card>
        <CardHeader>
          <CardTitle>Create agent</CardTitle>
        </CardHeader>
        <CardContent>
          <AgentForm key={formKey} submitLabel="Create agent" onSubmit={create} />
        </CardContent>
      </Card>
    </div>
  );
}
