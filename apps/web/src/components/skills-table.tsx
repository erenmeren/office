'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { AgentAvatar } from '@/components/ui/agent-avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { SearchInput } from '@/components/ui/search-input';
import { StatusPill } from '@/components/ui/status-pill';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { del, post } from '@/lib/api';
import { useAgents, useSkills, type Skill } from '@/lib/queries';
import { skillErrorText, skillSourceLabel } from '@/lib/skills';

const STATUS_TONE = { approved: 'done', pending_review: 'decision', rejected: 'failed' } as const;

/** The Library card of the Skill Library artboard: filter, table, per-row Update and Delete. */
export function SkillsTable() {
  const qc = useQueryClient();
  const skills = useSkills();
  const agents = useAgents();
  const [filter, setFilter] = useState('');
  const [busyId, setBusyId] = useState<string>();
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const refresh = () => qc.invalidateQueries({ queryKey: ['skills'] });
  const act = async (s: Skill, fn: () => Promise<string | void>) => {
    setBusyId(s.id);
    setError('');
    setNotice('');
    try {
      const msg = await fn();
      if (msg) setNotice(msg);
      await refresh();
    } catch (err) {
      setError(skillErrorText(err));
    } finally {
      setBusyId(undefined);
    }
  };
  const update = (s: Skill) =>
    act(s, async () => {
      const r = await post<{ created: boolean; version: { version: number } }>(`/skills/${s.id}/update`);
      return r.created ? `${s.name}: v${r.version.version} imported from its source.` : `${s.name}: already up to date.`;
    });
  const remove = (s: Skill) => {
    if (!window.confirm(`Delete "${s.name}" and all its versions?`)) return;
    void act(s, async () => {
      await del(`/skills/${s.id}`);
      return `${s.name} deleted.`;
    });
  };

  const q = filter.trim().toLowerCase();
  const rows = (skills.data ?? []).filter((s) => !q || s.name.includes(q) || s.description.toLowerCase().includes(q));
  const agentById = new Map((agents.data ?? []).map((a) => [a.id, a]));

  return (
    <Card>
      <CardHeader className="grid-cols-[1fr_auto]">
        <div>
          <CardTitle>Library</CardTitle>
          <CardDescription>Skill versions are immutable once published.</CardDescription>
        </div>
        <SearchInput aria-label="Filter skills" placeholder="Filter skills" value={filter} onChange={(e) => setFilter(e.target.value)} className="w-56" />
      </CardHeader>
      <CardContent className="space-y-2">
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {notice && <p className="text-sm text-mint">{notice}</p>}
        {skills.isPending && <p className="text-sm text-muted-foreground">Loading skills…</p>}
        {skills.isError && <p className="text-sm text-destructive">{String(skills.error)}</p>}
        {skills.isSuccess && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Skill</TableHead>
                <TableHead>Source</TableHead>
                <TableHead>Model</TableHead>
                <TableHead>Version</TableHead>
                <TableHead>Used by</TableHead>
                <TableHead>Status</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((s) => (
                <TableRow key={s.id}>
                  <TableCell className="max-w-md whitespace-normal">
                    <Link href={`/skills/${s.id}`} className="font-mono font-medium text-ink hover:underline">
                      {s.name}
                    </Link>
                    <p className="line-clamp-1 text-xs text-ink-3">{s.description}</p>
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline">{skillSourceLabel(s.source)}</Badge>
                  </TableCell>
                  <TableCell>{s.model ? <Badge variant="secondary">{s.model}</Badge> : <span className="text-ink-3">—</span>}</TableCell>
                  <TableCell className="font-mono text-ink-2">{s.currentVersion ? `v${s.currentVersion.version}` : '—'}</TableCell>
                  <TableCell>
                    {s.usedBy?.length ? (
                      <span className="flex -space-x-1">
                        {s.usedBy.map((id) => {
                          const a = agentById.get(id);
                          return a ? <AgentAvatar key={id} name={a.name} identity={a.slug} title={a.name} className="ring-2 ring-ground" /> : null;
                        })}
                      </span>
                    ) : (
                      <span className="text-ink-3">—</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <StatusPill status={s.status} tone={STATUS_TONE[s.status]} />
                  </TableCell>
                  <TableCell className="space-x-2 text-right">
                    {s.source !== 'ui' && (
                      <Button size="sm" variant="outline" disabled={busyId === s.id} onClick={() => update(s)}>
                        Update
                      </Button>
                    )}
                    <Button size="sm" variant="ghost" disabled={busyId === s.id} onClick={() => remove(s)}>
                      Delete
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
              {rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} className="text-muted-foreground">
                    {q ? 'No skill matches the filter.' : 'No skills yet.'}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        )}
        {skills.isSuccess && (
          <p className="text-xs text-ink-3">
            Showing {rows.length} of {skills.data.length} skills
          </p>
        )}
      </CardContent>
    </Card>
  );
}
