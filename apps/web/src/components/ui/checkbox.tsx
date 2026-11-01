import { cn } from 'cn';

function Checkbox({ className, ...props }: Omit<React.ComponentProps<'input'>, 'type'>) {
  return <input type="checkbox" data-slot="checkbox" className={cn('size-4 shrink-0 accent-violet outline-none focus-visible:ring-3 focus-visible:ring-ring/50', className)} {...props} />;
}

export { Checkbox };
