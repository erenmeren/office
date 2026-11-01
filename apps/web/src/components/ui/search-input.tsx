import { Search } from 'lucide-react';
import { cn } from 'cn';
import { Input } from '@/components/ui/input';

function SearchInput({ className, ...props }: React.ComponentProps<'input'>) {
  return (
    <div data-slot="search-input" className={cn('relative', className)}>
      <Search aria-hidden className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-ink-3" />
      <Input type="search" className="h-9 rounded-[10px] bg-[rgb(7_5_24/0.55)] pl-8" {...props} />
    </div>
  );
}

export { SearchInput };
