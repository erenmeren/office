'use client';

import { useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { post } from '@/lib/api';
import { useWorkers } from '@/lib/queries';

export default function WorkersPage() {
  const qc = useQueryClient();
  const workers = useWorkers();
  const [name, setName] = useState('');
  // held in memory only: the API returns the token once and stores just its hash
  const [token, setToken] = useState<string>();
  const [error, setError] = useState('');

  const add = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const res = await post<{ id: string; enrollToken: string }>('/workers', { name });
      setToken(res.enrollToken);
      setName('');
      await qc.invalidateQueries({ queryKey: ['workers'] });
    } catch (err) {
      setError(String(err));
    }
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Add worker</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <form onSubmit={add} className="flex gap-2">
            <Input placeholder="Worker name" required value={name} onChange={(e) => setName(e.target.value)} />
            <Button type="submit">Add worker</Button>
          </form>
          {error && <p className="text-sm text-destructive">{error}</p>}
          {token && (
            <div className="space-y-1 text-sm">
              <p>Shown once. Run on the worker machine:</p>
              <pre className="overflow-x-auto rounded bg-muted p-2 font-mono">
                OFFICE_ENROLL_TOKEN={token} pnpm --filter @office/worker dev
              </pre>
            </div>
          )}
        </CardContent>
      </Card>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Capacity</TableHead>
            <TableHead>Last heartbeat</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {workers.data?.map((w) => (
            <TableRow key={w.id}>
              <TableCell>{w.name}</TableCell>
              <TableCell>
                <Badge variant={w.status === 'online' ? 'default' : 'secondary'}>{w.status}</Badge>
              </TableCell>
              <TableCell>{w.capacity}</TableCell>
              <TableCell>{w.lastHeartbeatAt ? new Date(w.lastHeartbeatAt).toLocaleString() : '—'}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
