'use client';

import { cva } from 'class-variance-authority';
import { cn } from 'cn';
import { StatusDot } from '@/components/ui/status-pill';
import type { Tone } from '@/lib/status';

export const TASK_NODE = { w: 140, h: 96 } as const;

const nodeVariants = cva(
  'flex h-24 w-[140px] items-center rounded-xl border px-3 py-2.5 text-left outline-none transition-shadow focus-visible:ring-2 focus-visible:ring-ring aria-pressed:ring-2 aria-pressed:ring-cyan/70',
  {
    variants: {
      tone: {
        live: 'border-mint bg-mint/10 text-ink',
        decision: 'border-amber bg-amber/10 text-ink shadow-[0_0_0_3px_rgba(255,194,71,.25),0_0_30px_rgba(255,194,71,.25)]',
        failed: 'border-rose bg-rose/10 text-ink',
        done: 'border-white/22 bg-white/6 text-ink-2',
        idle: 'border-dashed border-white/22 bg-transparent text-ink',
      },
    },
    defaultVariants: { tone: 'idle' },
  },
);

interface TaskNodeProps extends Omit<React.ComponentProps<'button'>, 'children'> {
  code: string;
  title: string;
  assignee?: string;
  tone: Tone;
  selected?: boolean;
}

function TaskNode({ code, title, assignee, tone, selected, className, ...props }: TaskNodeProps) {
  return (
    <button type="button" aria-pressed={selected} data-slot="task-node" className={cn(nodeVariants({ tone }), className)} {...props}>
      <span className="flex w-full min-w-0 flex-col gap-[5px]">
        <span className="flex items-center gap-[7px]">
          <StatusDot tone={tone} />
          <span className="font-mono text-xs text-ink-3">{code}</span>
        </span>
        <span className="line-clamp-2 text-[13.5px] leading-[17px] font-semibold">{title}</span>
        {assignee && <span className="truncate text-xs text-ink-3">{assignee}</span>}
      </span>
    </button>
  );
}

export { TaskNode };
