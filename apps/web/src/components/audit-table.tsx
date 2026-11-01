'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useAudit, type AuditFilters } from '@/lib/queries';

const compact = (v: unknown) => (v == null ? '' : (JSON.stringify(v) ?? ''));

export function AuditTable() {
  const [filters, setFilters] = useState<AuditFilters>({});
  const [seen, setSeen] = useState<string[]>([]);
  const audit = useAudit(filters);
  const rows = audit.data?.pages.flat() ?? [];
  // options accumulate so narrowing by one action does not hide the others
  const fresh = rows.map((r) => r.action).filter((a) => !seen.includes(a));
  if (fresh.length) setSeen([...new Set([...seen, ...fresh])].sort());
  const set = (k: keyof AuditFilters, v: string) => setFilters({ ...filters, [k]: v || undefined });
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <NativeSelect aria-label="Action" className="w-56" value={filters.action ?? ''} onChange={(e) => set('action', e.target.value)}>
          <option value="">All actions</option>
          {seen.map((a) => (
            <option key={a}>{a}</option>
          ))}
        </NativeSelect>
        <Input aria-label="Target type" placeholder="Target type" className="w-44" value={filters.targetType ?? ''} onChange={(e) => set('targetType', e.target.value)} />
        <Input
          aria-label="Since"
          type="date"
          className="w-44"
          value={filters.since?.slice(0, 10) ?? ''}
          onChange={(e) => set('since', e.target.value && new Date(e.target.value).toISOString())}
        />
      </div>
      {audit.error && (
        <p role="alert" className="text-sm text-destructive">
          {audit.error.message}
        </p>
      )}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Time</TableHead>
            <TableHead>Action</TableHead>
            <TableHead>Target</TableHead>
            <TableHead>Detail</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={r.id}>
              <TableCell className="whitespace-nowrap font-mono text-xs">{new Date(r.createdAt).toLocaleString()}</TableCell>
              <TableCell>{r.action}</TableCell>
              <TableCell className="font-mono text-xs">{[r.targetType, r.targetId].filter(Boolean).join(' ')}</TableCell>
              <TableCell className="max-w-md truncate font-mono text-xs text-ink-3" title={compact(r.detail)}>
                {compact(r.detail)}
              </TableCell>
            </TableRow>
          ))}
          {!audit.isPending && rows.length === 0 && (
            <TableRow>
              <TableCell colSpan={4} className="text-ink-3">
                No audit entries.
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
      {audit.hasNextPage && (
        <Button variant="outline" disabled={audit.isFetchingNextPage} onClick={() => audit.fetchNextPage()}>
          Load older
        </Button>
      )}
    </div>
  );
}
