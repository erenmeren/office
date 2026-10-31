'use client';

import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useTasks, useWorkers } from '@/lib/queries';

export default function Dashboard() {
  const workers = useWorkers();
  const tasks = useTasks();
  const online = workers.data?.filter((w) => w.status === 'online').length ?? 0;
  const counts = new Map<string, number>();
  for (const t of tasks.data ?? []) counts.set(t.status, (counts.get(t.status) ?? 0) + 1);
  const latest = [...(tasks.data ?? [])].reverse().slice(0, 10);

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>Online workers</CardTitle>
        </CardHeader>
        <CardContent className="text-3xl font-semibold">{online}</CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Tasks by status</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          {counts.size === 0 && <span className="text-sm text-muted-foreground">No tasks</span>}
          {[...counts].map(([status, n]) => (
            <Badge key={status} variant="secondary">
              {status}: {n}
            </Badge>
          ))}
        </CardContent>
      </Card>
      <Card className="md:col-span-2">
        <CardHeader>
          <CardTitle>Last 10 tasks</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Title</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {latest.map((t) => (
                <TableRow key={t.id}>
                  <TableCell>
                    <Link href={`/tasks/${t.id}`} className="hover:underline">
                      {t.title}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <Link href={`/tasks/${t.id}`}>
                      <Badge variant="secondary">{t.status}</Badge>
                    </Link>
                  </TableCell>
                  <TableCell>{new Date(t.createdAt).toLocaleString()}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
