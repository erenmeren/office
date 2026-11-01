'use client';

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { SearchInput } from '@/components/ui/search-input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { post } from '@/lib/api';
import { useMarketSearch, useSkills, type MarketSkill } from '@/lib/queries';
import { skillErrorText } from '@/lib/skills';

const installs = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}K` : String(n));

/** skills.sh search (through the API) with one-click install; installed names show "Installed". */
export function SkillMarket() {
  const qc = useQueryClient();
  const skills = useSkills();
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const results = useMarketSearch(query);
  const [busyId, setBusyId] = useState<string>();
  const [error, setError] = useState('');
  const installed = new Set((skills.data ?? []).map((s) => s.name));

  const install = async (m: MarketSkill) => {
    setBusyId(m.id);
    setError('');
    try {
      await post('/skills/import', { source: 'market', id: m.id });
      await qc.invalidateQueries({ queryKey: ['skills'] });
    } catch (err) {
      setError(skillErrorText(err));
    } finally {
      setBusyId(undefined);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Marketplace</CardTitle>
        <CardDescription>Search skills.sh. An installed skill arrives as a Git skill awaiting review; Update re-reads its repository later.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            setQuery(q.trim());
          }}
        >
          <SearchInput aria-label="Search the marketplace" placeholder="Search skills.sh (e.g. react, testing, docs)" value={q} onChange={(e) => setQ(e.target.value)} className="flex-1" />
          <Button type="submit" disabled={!q.trim()}>
            Search
          </Button>
        </form>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {results.isFetching && <p className="text-sm text-muted-foreground">Searching…</p>}
        {results.isError && <p className="text-sm text-destructive">{skillErrorText(results.error)}</p>}
        {results.data && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Skill</TableHead>
                <TableHead>Repository</TableHead>
                <TableHead className="text-right">Installs</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {results.data.skills.map((m) => (
                <TableRow key={m.id}>
                  <TableCell className="font-mono">{m.name}</TableCell>
                  <TableCell>
                    <a href={`https://github.com/${m.source}`} target="_blank" rel="noreferrer" className="text-ink-2 hover:underline">
                      {m.source}
                    </a>
                  </TableCell>
                  <TableCell className="text-right font-mono text-ink-2">{installs(m.installs)}</TableCell>
                  <TableCell className="text-right">
                    {installed.has(m.skillId) ? (
                      <span className="text-xs text-ink-3">Installed</span>
                    ) : (
                      <Button size="sm" variant="outline" disabled={busyId === m.id} onClick={() => install(m)}>
                        {busyId === m.id ? 'Installing…' : 'Install'}
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
              {results.data.skills.length === 0 && (
                <TableRow>
                  <TableCell colSpan={4} className="text-muted-foreground">
                    No skill matches &ldquo;{query}&rdquo;.
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
