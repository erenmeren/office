import type { Tone } from './status';
import type { MemoryEntry } from './queries';

const TYPE_LABELS: Record<MemoryEntry['type'], string> = {
  decision: 'Decision',
  task_summary: 'Task history',
  known_issue: 'Known issue',
  convention: 'Knowledge',
  api_contract: 'Knowledge',
  lesson: 'Agent learning',
};
export const memoryTypeLabel = (type: MemoryEntry['type']) => TYPE_LABELS[type];

const STATUS_TONES: Record<MemoryEntry['status'], Tone> = { verified: 'done', proposed: 'decision', rejected: 'failed' };
export const memoryStatusTone = (status: MemoryEntry['status']): Tone => STATUS_TONES[status];

const STATUS_LABELS: Record<MemoryEntry['status'], string> = { verified: 'Verified', proposed: 'Needs review', rejected: 'Rejected' };
export const memoryStatusLabel = (status: MemoryEntry['status']) => STATUS_LABELS[status];

export function sourceLabel(s: MemoryEntry['sources'][number]): string {
  if (s.label) return s.label;
  switch (s.kind) {
    case 'run': return `Run ${s.ref.slice(0, 8)}`;
    case 'task': return `Task ${s.ref.slice(0, 8)}`;
    case 'message': return `Message ${s.ref.slice(0, 8)}`;
    case 'commit': return `Commit ${s.ref.slice(0, 7)}`;
    case 'event': return `Event ${s.ref}`;
    default: return s.ref;
  }
}

/** Type pills group `convention` and `api_contract` under "Knowledge". */
export const TYPE_FILTERS = [
  { value: 'all', label: 'All types' },
  { value: 'decision', label: 'Decision' },
  { value: 'task_summary', label: 'Task history' },
  { value: 'known_issue', label: 'Known issue' },
  { value: 'knowledge', label: 'Knowledge' },
  { value: 'lesson', label: 'Agent learning' },
] as const;
export type TypeFilter = (typeof TYPE_FILTERS)[number]['value'];
export const matchesType = (e: MemoryEntry, f: TypeFilter) => f === 'all' || (f === 'knowledge' ? memoryTypeLabel(e.type) === 'Knowledge' : e.type === f);
