'use client';

import { useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { post } from '@/lib/api';
import type { Agent, Conversation } from '@/lib/queries';

/** Inline panel under the header actions: `human` picks one agent, `group` a title and several. */
export function NewConversation({
  mode,
  projectId,
  agents,
  onCreated,
  onCancel,
}: {
  mode: 'human' | 'group';
  projectId: string;
  agents: Agent[];
  onCreated: (c: Conversation) => void;
  onCancel: () => void;
}) {
  const qc = useQueryClient();
  const [agentId, setAgentId] = useState(agents[0]?.id ?? '');
  const [picked, setPicked] = useState<string[]>([]);
  const [title, setTitle] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const ids = mode === 'human' ? [agentId] : picked;
  const valid = mode === 'human' ? !!agentId : !!title.trim() && picked.length >= 2;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const c = await post<Conversation>('/conversations', {
        projectId,
        kind: mode,
        agentIds: ids,
        ...(mode === 'group' ? { title: title.trim() } : {}),
      });
      await qc.invalidateQueries({ queryKey: ['conversations'] });
      onCreated(c);
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{mode === 'human' ? 'Message an agent' : 'New group'}</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="flex flex-col gap-3">
          {mode === 'human' ? (
            <div className="space-y-1.5">
              <Label htmlFor="conv-agent">Agent</Label>
              <NativeSelect id="conv-agent" value={agentId} onChange={(e) => setAgentId(e.target.value)}>
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </NativeSelect>
            </div>
          ) : (
            <>
              <div className="space-y-1.5">
                <Label htmlFor="conv-title">Group title</Label>
                <Input id="conv-title" value={title} onChange={(e) => setTitle(e.target.value)} />
              </div>
              <fieldset className="flex flex-wrap gap-x-4 gap-y-2">
                <legend className="mb-1.5 text-sm">Agents (at least two)</legend>
                {agents.map((a) => (
                  <label key={a.id} className="inline-flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={picked.includes(a.id)}
                      onChange={(e) => setPicked(e.target.checked ? [...picked, a.id] : picked.filter((x) => x !== a.id))}
                    />
                    {a.name}
                  </label>
                ))}
              </fieldset>
            </>
          )}
          <div className="flex gap-2">
            <Button type="submit" disabled={busy || !valid}>
              {mode === 'human' ? 'Start conversation' : 'Create group'}
            </Button>
            <Button type="button" variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </form>
      </CardContent>
    </Card>
  );
}
