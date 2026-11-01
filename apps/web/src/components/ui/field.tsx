import { cn } from 'cn';
import { Label } from '@/components/ui/label';

interface FieldProps extends React.ComponentProps<'div'> {
  label: string;
  htmlFor: string;
  hint?: string;
  error?: string;
}

/** A labelled form control. */
function Field({ label, htmlFor, hint, error, className, children, ...props }: FieldProps) {
  return (
    <div data-slot="field" className={cn('flex min-w-0 flex-col gap-1.5', className)} {...props}>
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      {hint && <p className="text-xs text-ink-3">{hint}</p>}
    </div>
  );
}

export { Field };
