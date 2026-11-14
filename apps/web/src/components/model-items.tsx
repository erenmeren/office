'use client';

import { useState } from 'react';
import { SelectItem } from '@/components/ui/select';
import { modelChoices } from '@/lib/models';
import { useModels } from '@/lib/queries';

/**
 * The items of a model select: what the worker's Claude login offers today (`GET /models`), each with the name the
 * owner knows and, where it differs, the id the runtime is told. `current` stays in the list when it is not offered.
 */
export function ModelItems({ current }: { current: string }) {
  // the model the form opened with stays in the list for as long as the form is open: the owner can go back to it,
  // and the list does not change under an open select
  const [kept] = useState(current);
  return modelChoices(useModels().data, kept).map((m) => (
    <SelectItem key={m.value} value={m.value}>
      {m.label}
      {m.label !== m.value && <span className="font-mono text-xs text-ink-3">{m.value}</span>}
    </SelectItem>
  ));
}
