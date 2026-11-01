import { mergeProps } from '@base-ui/react/merge-props';
import { useRender } from '@base-ui/react/use-render';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from 'cn';

const chipVariants = cva(
  'inline-flex h-8 shrink-0 items-center gap-2 rounded-[10px] border px-3 text-[13px] font-medium whitespace-nowrap outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring aria-expanded:ring-2 aria-expanded:ring-cyan/60 [&>svg]:size-3.5 [&>svg]:shrink-0',
  {
    variants: {
      tone: {
        neutral: 'border-white/18 bg-white/7 text-ink hover:bg-white/12',
        passed: 'border-mint/40 bg-mint/12 text-mint hover:bg-mint/18',
        failed: 'border-rose/45 bg-rose/12 text-rose hover:bg-rose/18',
      },
    },
    defaultVariants: { tone: 'neutral' },
  },
);

/** One piece of evidence (diff, tests, memory, conversation) that opens its source. Renders a button unless `render` swaps it. */
function EvidenceChip({ className, tone, render, ...props }: useRender.ComponentProps<'button'> & VariantProps<typeof chipVariants>) {
  return useRender({
    defaultTagName: 'button',
    props: mergeProps<'button'>({ type: render ? undefined : 'button', className: cn(chipVariants({ tone }), className) }, props),
    render,
    state: { slot: 'evidence-chip', tone },
  });
}

export { EvidenceChip, chipVariants };
