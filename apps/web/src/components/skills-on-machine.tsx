'use client';

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { post } from '@/lib/api';
import { useMachineSkills, type MachineSkill } from '@/lib/queries';
import { skillErrorText } from '@/lib/skills';

/** Your own Claude Code skills found on this machine, importable with one click (they wait for review like any import). */
export function SkillsOnMachine() {
  const qc = useQueryClient();
  const q = useMachineSkills();
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState('');
  const importOne = async (s: MachineSkill) => {
    setBusy(s.path);
    setError('');
    try {
      await post('/skills/import', { source: 'local', path: s.path });
      await qc.invalidateQueries({ queryKey: ['skills'] });
    } catch (err) {
      setError(`${s.name}: ${skillErrorText(err)}`);
    } finally {
      setBusy(undefined);
    }
  };
  const list = q.data ?? [];
  const pending = list.filter((s) => !s.skillId);
  return (
    <Card>
      <CardHeader>
        <CardTitle>On this machine</CardTitle>
        <CardDescription>
          Skills your own Claude Code uses: <code className="font-mono text-xs">~/.claude/skills</code> and the skills of installed plugins. Office keeps its own copy per import; agents never read your folder.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {error && <p className="text-sm text-destructive">{error}</p>}
        {q.isLoading ? (
          <p className="text-[13px] text-ink-3">Looking…</p>
        ) : list.length === 0 ? (
          <p className="text-[13px] text-ink-3">No skills found under ~/.claude on the machine the API runs on.</p>
        ) : (
          <>
            {pending.length > 1 && (
              <Button
                size="sm"
                variant="secondary"
                disabled={!!busy}
                onClick={async () => {
                  for (const s of pending) await importOne(s);
                }}
              >
                Import all {pending.length}
              </Button>
            )}
            <Table aria-label="Skills on this machine">
              <TableHeader>
                <TableRow>
                  <TableHead>Skill</TableHead>
                  <TableHead>From</TableHead>
                  <TableHead>Description</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {list.map((s) => (
                  <TableRow key={s.path}>
                    <TableCell className="font-medium text-ink">{s.name}</TableCell>
                    <TableCell>
                      <Badge variant="outline">{s.origin === 'user' ? 'your skills' : s.origin.slice(7)}</Badge>
                    </TableCell>
                    <TableCell className="max-w-[420px] truncate text-ink-2" title={s.description}>{s.description || '—'}</TableCell>
                    <TableCell className="text-right">
                      {s.skillId ? (
                        <Link href={`/skills/${s.skillId}`} className="text-sm text-ink-2 underline-offset-4 hover:underline">Imported</Link>
                      ) : (
                        <Button size="xs" variant="secondary" disabled={busy === s.path} onClick={() => importOne(s)}>
                          {busy === s.path ? 'Importing…' : 'Import'}
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </>
        )}
      </CardContent>
    </Card>
  );
}
