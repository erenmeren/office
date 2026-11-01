import { cn } from 'cn';
import { Segmented } from '@/components/ui/segmented';

export type PolicyMode = 'ask' | 'auto' | 'block';

const OPTIONS: { value: PolicyMode; label: string }[] = [
  { value: 'ask', label: 'Ask' },
  { value: 'auto', label: 'Auto' },
  { value: 'block', label: 'Block' },
];

/** Ask / Auto / Block choice for one approval policy. */
function ToggleGroup({ className, ...props }: Omit<React.ComponentProps<typeof Segmented<PolicyMode>>, 'options'>) {
  return <Segmented data-slot="toggle-group" options={OPTIONS} className={cn(className)} {...props} />;
}

export { ToggleGroup };
