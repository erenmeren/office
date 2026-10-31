'use client';

import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { ApiError, post } from '@/lib/api';
import { useSkills } from '@/lib/queries';

const TEMPLATE =
  '---\nname: my-skill\ndescription: One line on when to use this skill\n---\n\n# My skill\n\n## When to use\n\n## Steps\n\n## Done when\n';

function errorText(err: unknown): string {
  const b = err instanceof ApiError ? (err.body as { error?: string; code?: string; message?: string } | undefined) : undefined;
  return b?.error === 'invalid_skill' ? `${b.code}: ${b.message}` : String(err);
}

export default function SkillsPage() {
  const qc = useQueryClient();
  const skills = useSkills();
  const [mode, setMode] = useState<'local' | 'git'>('local');
  const [imp, setImp] = useState({ path: '', url: '', ref: '', gitPath: '' });
  const [impError, setImpError] = useState('');
  const [name, setName] = useState('');
  const [text, setText] = useState(TEMPLATE);
  const [newError, setNewError] = useState('');
  const [rowError, setRowError] = useState('');

  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: ['skills'] });
    await qc.invalidateQueries({ queryKey: ['skill'] });
  };

  const review = async (id: string, action: 'approve' | 'reject') => {
    setRowError('');
    try {
      await post(`/skills/${id}/${action}`);
      await refresh();
    } catch (err) {
      setRowError(errorText(err));
    }
  };

  const doImport = async (e: FormEvent) => {
    e.preventDefault();
    setImpError('');
    try {
      await post(
        '/skills/import',
        mode === 'local'
          ? { source: 'local', path: imp.path }
          : { source: 'git', url: imp.url, ref: imp.ref || undefined, path: imp.gitPath || undefined },
      );
      setImp({ path: '', url: '', ref: '', gitPath: '' });
      await refresh();
    } catch (err) {
      setImpError(errorText(err));
    }
  };

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setNewError('');
    try {
      await post('/skills', { name, files: { 'SKILL.md': text } });
      setName('');
      setText(TEMPLATE);
      await refresh();
    } catch (err) {
      setNewError(errorText(err));
    }
  };

  return (
    <div className="space-y-4">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Description</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Version</TableHead>
            <TableHead>Source</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {skills.data?.map((s) => (
            <TableRow key={s.id}>
              <TableCell>
                <Link href={`/skills/${s.id}`} className="font-mono underline">
                  {s.name}
                </Link>
              </TableCell>
              <TableCell>{s.description}</TableCell>
              <TableCell>
                <Badge variant="outline">{s.status}</Badge>
              </TableCell>
              <TableCell>{s.currentVersion?.version ?? '—'}</TableCell>
              <TableCell>{s.source}</TableCell>
              <TableCell className="space-x-2">
                {s.status === 'pending_review' && (
                  <>
                    <Button size="sm" onClick={() => review(s.id, 'approve')}>
                      Approve
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => review(s.id, 'reject')}>
                      Reject
                    </Button>
                  </>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {rowError && <p className="text-sm text-destructive">{rowError}</p>}

      <Card>
        <CardHeader>
          <CardTitle>Import skill</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={doImport} className="space-y-3">
            <div className="flex gap-2">
              {(['local', 'git'] as const).map((m) => (
                <Button key={m} type="button" size="sm" variant={mode === m ? 'default' : 'outline'} onClick={() => setMode(m)}>
                  {m}
                </Button>
              ))}
            </div>
            {mode === 'local' ? (
              <div className="space-y-1">
                <Label htmlFor="impPath">Path</Label>
                <Input id="impPath" required value={imp.path} onChange={(e) => setImp({ ...imp, path: e.target.value })} />
              </div>
            ) : (
              <>
                <div className="space-y-1">
                  <Label htmlFor="impUrl">URL</Label>
                  <Input id="impUrl" required value={imp.url} onChange={(e) => setImp({ ...imp, url: e.target.value })} />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="impRef">Ref (optional)</Label>
                  <Input id="impRef" value={imp.ref} onChange={(e) => setImp({ ...imp, ref: e.target.value })} />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="impGitPath">Path (optional)</Label>
                  <Input id="impGitPath" value={imp.gitPath} onChange={(e) => setImp({ ...imp, gitPath: e.target.value })} />
                </div>
              </>
            )}
            {impError && <p className="text-sm text-destructive">{impError}</p>}
            <Button type="submit">Import</Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>New skill</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={create} className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="skillName">Name</Label>
              <Input id="skillName" required value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="skillMd">SKILL.md</Label>
              <Textarea id="skillMd" rows={14} className="font-mono" value={text} onChange={(e) => setText(e.target.value)} />
            </div>
            {newError && <p className="text-sm text-destructive">{newError}</p>}
            <Button type="submit">Create skill</Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
