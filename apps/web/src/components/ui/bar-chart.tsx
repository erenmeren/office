import { cn } from 'cn';
import { niceMax, type Bar } from '@/lib/dashboard';

interface BarChartProps extends Omit<React.ComponentProps<'div'>, 'children'> {
  bars: Bar[];
  /** Read by screen readers in place of the bars. */
  label: string;
  format: (n: number) => string;
}

/** Single-series vertical bars in CSS; a partial bar (today) is dashed amber and carries its value. */
function BarChart({ bars, label, format, className, ...props }: BarChartProps) {
  const top = niceMax(Math.max(0, ...bars.map((b) => b.value)));
  const ticks = [top, top / 2, 0];
  return (
    <div role="img" aria-label={label} data-slot="bar-chart" className={cn('flex gap-3', className)} {...props}>
      <div className="flex h-40 flex-col justify-between pb-5 text-right font-mono text-[11px] text-ink-3">
        {ticks.map((t) => (
          <span key={t} className="-translate-y-1/2 first:translate-y-0 last:translate-y-1/2">
            {format(t).replace(/\.00$/, '')}
          </span>
        ))}
      </div>
      <div className="flex h-40 flex-1 gap-0.5">
        {bars.map((b, i) => (
          <div key={i} className="flex min-w-0 flex-1 flex-col items-center gap-1.5">
            <div className="flex w-full flex-1 flex-col items-center justify-end border-b border-white/13">
              {b.partial && <span className="mb-1 font-mono text-[11px] text-ink">{format(b.value)}</span>}
              <div
                data-slot="bar"
                data-partial={b.partial || undefined}
                title={`${b.label}: ${format(b.value)}${b.partial ? ' (partial)' : ''}`}
                className={cn(
                  'w-full max-w-9 rounded-t-[4px] bg-violet',
                  b.partial && 'border border-b-0 border-dashed border-amber bg-amber/45',
                )}
                style={{ height: `${(b.value / top) * 100}%` }}
              />
            </div>
            <span className={cn('h-3.5 text-[11px] leading-3.5 text-ink-3', b.partial && 'text-ink')}>{b.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export { BarChart };
