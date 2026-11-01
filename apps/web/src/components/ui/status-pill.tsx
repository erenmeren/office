import { cva, type VariantProps } from 'class-variance-authority';
import { Check, X } from 'lucide-react';
import { cn } from 'cn';
import { statusLabel, statusTone, type Tone } from '@/lib/status';

/** Every state has a shape and a word, never color alone. */
function StatusDot({ tone, className }: { tone: Tone; className?: string }) {
  if (tone === 'failed') return <X aria-hidden className={cn('size-3 shrink-0 text-rose', className)} strokeWidth={2.6} />;
  if (tone === 'done') return <Check aria-hidden className={cn('size-3 shrink-0', className)} strokeWidth={2.6} />;
  if (tone === 'decision') return <span aria-hidden className={cn('size-[7px] shrink-0 rotate-45 bg-amber', className)} />;
  if (tone === 'live')
    return (
      <span aria-hidden className={cn('relative size-[7px] shrink-0', className)}>
        <span className="absolute inset-0 animate-ping rounded-full bg-mint/70 motion-reduce:hidden" />
        <span className="absolute inset-0 rounded-full bg-mint" />
      </span>
    );
  return <span aria-hidden className={cn('size-[7px] shrink-0 rounded-full border-[1.5px] border-ink-2', className)} />;
}

const pillVariants = cva(
  'inline-flex h-6 shrink-0 items-center gap-[7px] rounded-full border px-2.5 text-[12.5px] font-medium whitespace-nowrap',
  {
    variants: {
      tone: {
        live: 'border-mint/40 bg-mint/15 text-mint shadow-[0_0_18px_rgba(61,245,200,.22)]',
        decision: 'border-amber/45 bg-amber/15 text-amber shadow-[0_0_18px_rgba(255,194,71,.22)]',
        failed: 'border-rose/45 bg-rose/15 text-rose',
        done: 'border-white/13 bg-white/10 text-ink-2',
        idle: 'border-white/22 bg-white/6 text-ink-2',
      },
    },
    defaultVariants: { tone: 'idle' },
  },
);

interface StatusPillProps extends Omit<React.ComponentProps<'span'>, 'children'>, VariantProps<typeof pillVariants> {
  /** Raw status (task, run, worker, skill). Tone and label derive from it unless overridden. */
  status: string;
  label?: string;
}

function StatusPill({ status, tone, label, className, ...props }: StatusPillProps) {
  const t = tone ?? statusTone(status);
  return (
    <span data-slot="status-pill" data-tone={t} className={cn(pillVariants({ tone: t }), className)} {...props}>
      <StatusDot tone={t} />
      {label ?? statusLabel(status)}
    </span>
  );
}

export { StatusDot, StatusPill, pillVariants };
