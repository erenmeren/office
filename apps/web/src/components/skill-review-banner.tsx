'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { StatusPill } from '@/components/ui/status-pill';
import { post } from '@/lib/api';
import { useSkills } from '@/lib/queries';
import { skillErrorText, skillSourceLabel } from '@/lib/skills';

/** One banner per skill awaiting review (Skill Library artboard): Approve, Inspect files, Reject. */
export function SkillReviewBanners() {
  const qc = useQueryClient();
  const skills = useSkills();
  const [error, setError] = useState('');
  const pending = skills.data?.filter((s) => s.status === 'pending_review') ?? [];
  if (pending.length === 0) return null;

  const review = async (id: string, action: 'approve' | 'reject') => {
    setError('');
    try {
      await post(`/skills/${id}/${action}`);
      await qc.invalidateQueries({ queryKey: ['skills'] });
    } catch (err) {
      setError(skillErrorText(err));
    }
  };

  return (
    <div className="space-y-3">
      {pending.map((s) => (
        <Card key={s.id} size="sm" className="border-amber/45">
          <CardContent className="flex flex-wrap items-center gap-4">
            <div className="min-w-0 flex-[999_1_360px] space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <StatusPill status="pending_review" tone="decision" label="Import needs review" />
                <span className="font-mono font-semibold text-ink">{s.name}</span>
                <span className="text-xs text-ink-3">v{s.currentVersion?.version ?? 1} · new</span>
              </div>
              <p className="text-sm text-ink-2">{s.description}</p>
              <p className="truncate font-mono text-xs text-ink-3">
                {skillSourceLabel(s.source)}
                {s.sourceRef ? ` · ${s.sourceRef}` : ''}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" onClick={() => review(s.id, 'approve')}>
                Approve and import as v{s.currentVersion?.version ?? 1}
              </Button>
              <Button size="sm" variant="outline" nativeButton={false} render={<Link href={`/skills/${s.id}`} />}>
                Inspect files
              </Button>
              <Button size="sm" variant="ghost" onClick={() => review(s.id, 'reject')}>
                Reject
              </Button>
            </div>
            <p className="basis-full text-xs text-ink-3">Imported skills are untrusted. They cannot widen what an agent is allowed to do.</p>
          </CardContent>
        </Card>
      ))}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
