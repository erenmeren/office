'use client';

import { useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { post } from '@/lib/api';
import { useAgents } from '@/lib/queries';

const MODELS = ['fable', 'opus', 'sonnet', 'haiku'];
const EMPTY = { name: '', slug: '', role: '', systemPrompt: '', model: 'sonnet', tools: 'Read,Glob,Grep,Bash,Edit,Write' };

export default function AgentsPage() {
  const qc = useQueryClient();
  const agents = useAgents();
  const [form, setForm] = useState(EMPTY);
  const [error, setError] = useState('');
  const set = (k: keyof typeof EMPTY) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    try {
      await post('/agents', {
        name: form.name,
        slug: form.slug,
        role: form.role,
        config: {
          systemPrompt: form.systemPrompt,
          model: form.model,
          allowedTools: form.tools.split(',').map((t) => t.trim()).filter(Boolean),
        },
      });
      setForm(EMPTY);
      await qc.invalidateQueries({ queryKey: ['agents'] });
    } catch (err) {
      setError(String(err));
    }
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
          </TableRow>
        </TableHeader>
        <TableBody>
          {agents.data?.map((a) => (
            <TableRow key={a.id}>
              <TableCell>{a.name}</TableCell>
              <TableCell className="font-mono">{a.slug}</TableCell>
              <TableCell>{a.role}</TableCell>
              <TableCell>{a.currentVersion?.version ?? '—'}</TableCell>
              <TableCell>{a.currentVersion?.config.model ?? '—'}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      <Card>
        <CardHeader>
          <CardTitle>Create agent</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={create} className="space-y-3">
            {(['name', 'slug', 'role'] as const).map((k) => (
              <div key={k} className="space-y-1">
                <Label htmlFor={k} className="capitalize">
                  {k}
                </Label>
                <Input id={k} required value={form[k]} onChange={set(k)} />
              </div>
            ))}
            <div className="space-y-1">
              <Label htmlFor="systemPrompt">System prompt</Label>
              <Textarea id="systemPrompt" rows={5} value={form.systemPrompt} onChange={set('systemPrompt')} />
            </div>
            <div className="space-y-1">
              <Label>Model</Label>
              <Select value={form.model} onValueChange={(v) => setForm({ ...form, model: String(v) })}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {MODELS.map((m) => (
                    <SelectItem key={m} value={m}>
                      {m}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="tools">Allowed tools (comma-separated)</Label>
              <Input id="tools" value={form.tools} onChange={set('tools')} />
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <Button type="submit">Create agent</Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
