import { cn } from 'cn';

/** The dashboard's KPI strip: five equal cards that wrap on narrow screens. */
function KpiRow({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="kpi-row" className={cn('grid gap-4 sm:grid-cols-2 lg:grid-cols-5', className)} {...props} />;
}

interface KpiCardProps extends Omit<React.ComponentProps<'div'>, 'children'> {
  label: string;
  value: string | number;
  /** Shown after the value, e.g. "/ 10". */
  of?: string;
  sub?: string;
}

/** Label, headline number and one line of context. */
function KpiCard({ label, value, of, sub, className, ...props }: KpiCardProps) {
  return (
    <div data-slot="kpi-card" className={cn('glass flex min-w-0 flex-col gap-1.5 rounded-[20px] p-5', className)} {...props}>
      <div className="text-[13px] font-medium text-ink-3">{label}</div>
      <div className="flex items-baseline gap-1.5">
        <span className="font-heading text-[30px] leading-9 font-semibold tracking-[-0.02em] text-ink">{value}</span>
        {of && <span className="font-mono text-sm text-ink-3">{of}</span>}
      </div>
      {sub && <div className="truncate text-[12.5px] text-ink-2">{sub}</div>}
    </div>
  );
}

/** Two columns on wide screens: the wide main column and the side rail. */
function DashboardColumns({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="dashboard-columns" className={cn('grid items-start gap-4 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]', className)} {...props} />;
}

function DashboardStack({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="dashboard-stack" className={cn('flex min-w-0 flex-col gap-4', className)} {...props} />;
}

export { DashboardColumns, DashboardStack, KpiCard, KpiRow };
