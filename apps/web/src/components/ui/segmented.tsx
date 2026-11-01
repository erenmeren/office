import { cn } from 'cn';

interface SegmentedProps<T extends string> extends Omit<React.ComponentProps<'div'>, 'onChange'> {
  options: { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  label: string;
}

function Segmented<T extends string>({ options, value, onChange, label, className, ...props }: SegmentedProps<T>) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      data-slot="segmented"
      className={cn('inline-flex gap-0.5 rounded-full border border-white/13 bg-white/6 p-0.5', className)}
      {...props}
    >
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          onClick={() => onChange(o.value)}
          className={cn(
            'h-7 rounded-full px-3 text-[12.5px] font-medium text-ink-2 outline-none hover:text-ink focus-visible:ring-3 focus-visible:ring-ring/50',
            o.value === value && 'bg-violet/40 text-ink shadow-[inset_0_1px_0_rgba(255,255,255,.18)]',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export { Segmented };
