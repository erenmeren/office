'use client';

import { useParams } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { ApiError, post } from '@/lib/api';
import { useSkill } from '@/lib/queries';

function errorText(err: unknown): string {
  const b = err instanceof ApiError ? (err.body as { error?: string; code?: string; message?: string } | undefined) : undefined;
  return b?.error === 'invalid_skill' ? `${b.code}: ${b.message}` : String(err);
}

const PRE = 'whitespace-pre-wrap break-words rounded-md bg-muted p-3 font-mono text-sm';

export default function SkillPage() {
  const { id } = useParams<{ id: string }>();
  const qc = useQueryClient();
  const skill = useSkill(id);
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState('');

  const s = skill.data;
  const files = s?.currentVersion?.files ?? {};
  const others = Object.entries(files).filter(([p]) => p !== 'SKILL.md');

  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: ['skills'] });
    await qc.invalidateQueries({ queryKey: ['skill', id] });
  };

  const act = async (fn: () => Promise<unknown>) => {
    setError('');
    try {
      await fn();
      await refresh();
    } catch (err) {
      setError(errorText(err));
    }
  };

  const save = (e: FormEvent) => {
    e.preventDefault();
    void act(async () => {
      await post(`/skills/${id}/versions`, { files: { ...files, 'SKILL.md': draft ?? files['SKILL.md'] ?? '' } });
      setDraft(null);
    });
  };

  if (!s) return <p className="text-sm text-muted-foreground">Loading…</p>;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <h1 className="font-mono text-xl font-semibold">{s.name}</h1>
        <Badge variant="outline">{s.status}</Badge>
        <span className="text-sm text-muted-foreground">
          {s.source}
          {s.sourceRef ? ` · ${s.sourceRef}` : ''}
        </span>
        <div className="ml-auto space-x-2">
          {s.status !== 'approved' && (
            <Button size="sm" onClick={() => act(() => post(`/skills/${id}/approve`))}>
              Approve
            </Button>
          )}
          {s.status !== 'rejected' && (
            <Button size="sm" variant="outline" onClick={() => act(() => post(`/skills/${id}/reject`))}>
              Reject
            </Button>
          )}
        </div>
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Version</TableHead>
            <TableHead>Checksum</TableHead>
            <TableHead>Created</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {s.versions?.map((v) => (
            <TableRow key={v.id}>
              <TableCell>{v.version}</TableCell>
              <TableCell className="font-mono">{v.checksum.slice(0, 12)}</TableCell>
              <TableCell>{new Date(v.createdAt).toLocaleString()}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      <Card>
        <CardHeader>
          <CardTitle>SKILL.md</CardTitle>
        </CardHeader>
        <CardContent>
          <pre className={PRE}>{files['SKILL.md']}</pre>
        </CardContent>
      </Card>

      {others.map(([path, text]) => (
        <Card key={path}>
          <CardHeader>
            <CardTitle className="font-mono">{path}</CardTitle>
          </CardHeader>
          <CardContent>
            <pre className={PRE}>{text}</pre>
          </CardContent>
        </Card>
      ))}

      <Card>
        <CardHeader>
          <CardTitle>Edit</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={save} className="space-y-3">
            <Textarea
              aria-label="SKILL.md"
              rows={16}
              className="font-mono"
              value={draft ?? files['SKILL.md'] ?? ''}
              onChange={(e) => setDraft(e.target.value)}
            />
            <Button type="submit">Save new version</Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
