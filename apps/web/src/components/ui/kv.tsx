import { cn } from 'cn';

/** Uppercase caption over a value: the "Assigned to / Worker / Budget" grid cells. */
function Kv({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="kv" className={cn('flex min-w-0 flex-col gap-1.5', className)} {...props} />;
}

function KvLabel({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="kv-label"
      className={cn('text-xs font-semibold tracking-[0.04em] uppercase text-ink-3', className)}
      {...props}
    />
  );
}

function KvValue({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="kv-value" className={cn('flex flex-wrap items-center gap-2 text-[13px] text-ink', className)} {...props} />;
}

export { Kv, KvLabel, KvValue };
