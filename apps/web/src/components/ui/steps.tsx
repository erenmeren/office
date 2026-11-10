import { cn } from 'cn';

/** A short pipeline: the steps before `current` are done, `current` is the one in progress. */
function Steps({ steps, current, className, ...props }: React.ComponentProps<'ol'> & { steps: readonly string[]; current: number }) {
  return (
    <ol data-slot="steps" className={cn('flex gap-1.5', className)} {...props}>
      {steps.map((step, i) => (
        <li
          key={step}
          aria-current={i === current ? 'step' : undefined}
          className={cn('flex-1 border-t-2 pt-1 text-[11px]', i < current ? 'border-mint/50 text-ink-3' : i === current ? 'border-mint font-medium text-ink' : 'border-white/13 text-ink-3')}
        >
          {step}
        </li>
      ))}
    </ol>
  );
}

export { Steps };
