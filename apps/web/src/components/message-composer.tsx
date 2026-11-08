'use client';

import { useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Send } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Segmented } from '@/components/ui/segmented';
import { Textarea } from '@/components/ui/textarea';
import { post } from '@/lib/api';

type Kind = 'message' | 'question';

/** `ask`: every message is a question (a note would not wake the agent); no type switch. */
export function MessageComposer({ conversationId, ask = false }: { conversationId: string; ask?: boolean }) {
  const qc = useQueryClient();
  const [type, setType] = useState<Kind>(ask ? 'question' : 'message');
  const [body, setBody] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const send = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await post(`/conversations/${conversationId}/messages`, { type, body: body.trim() });
      setBody('');
      await qc.invalidateQueries({ queryKey: ['conversation', conversationId] });
      await qc.invalidateQueries({ queryKey: ['conversations'] });
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={send} className="flex flex-col gap-2 border-t border-white/10 pt-3">
      <Textarea
        aria-label="Message"
        rows={2}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder="Write a message. It is saved before it is delivered."
        variant="well"
      />
      <div className="flex items-center justify-between gap-3">
        {ask ? (
          <span />
        ) : (
          <Segmented
            label="Message type"
            value={type}
            onChange={setType}
            options={[
              { value: 'message', label: 'Note' },
              { value: 'question', label: 'Question' },
            ]}
          />
        )}
        <Button type="submit" size="lg" disabled={busy || !body.trim()}>
          <Send data-icon="inline-start" aria-hidden />
          Send
        </Button>
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
    </form>
  );
}
