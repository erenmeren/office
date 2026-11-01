import { cn } from 'cn';

interface ProgressProps extends React.ComponentProps<'div'> {
  /** 0..100 */
  value: number;
  label?: string;
}

function Progress({ value, label, className, ...props }: ProgressProps) {
  const pct = Math.max(0, Math.min(100, value));
  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(pct)}
      aria-label={label}
      data-slot="progress"
      className={cn('h-1.5 w-full overflow-hidden rounded-full bg-white/12', className)}
      {...props}
    >
      <div className="h-full rounded-full bg-linear-to-r from-violet to-mint" style={{ width: `${pct}%` }} />
    </div>
  );
}

export { Progress };
