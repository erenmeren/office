import { cva } from 'class-variance-authority';
import { cn } from 'cn';
import { StatusPill } from '@/components/ui/status-pill';
import { memoryStatusLabel, memoryStatusTone, memoryTypeLabel } from '@/lib/memory';
import type { MemoryEntry } from '@/lib/queries';

const typeVariants = cva('inline-flex h-5 shrink-0 items-center rounded-md border px-1.5 text-[11px] font-semibold tracking-[0.02em] whitespace-nowrap', {
  variants: {
    group: {
      Decision: 'border-violet/50 bg-violet/20 text-ink',
      'Task history': 'border-white/22 bg-white/8 text-ink-2',
      'Known issue': 'border-rose/45 bg-rose/15 text-rose',
      Knowledge: 'border-cyan/40 bg-cyan/12 text-cyan',
      'Agent learning': 'border-mint/40 bg-mint/12 text-mint',
    },
  },
});

function TypeTag({ type, className }: { type: MemoryEntry['type']; className?: string }) {
  const label = memoryTypeLabel(type);
  return (
    <span data-slot="type-tag" className={cn(typeVariants({ group: label as 'Decision' }), className)}>
      {label}
    </span>
  );
}

function MemoryStatusTag({ status, label, className }: { status: MemoryEntry['status']; label?: string; className?: string }) {
  return <StatusPill status={status} tone={memoryStatusTone(status)} label={label ?? memoryStatusLabel(status)} className={cn('h-5 text-[11px]', className)} />;
}

export { MemoryStatusTag, TypeTag };
