import { cn } from 'cn';

function PageHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="page-header"
      className={cn('mb-6 flex flex-wrap items-end justify-between gap-4', className)}
      {...props}
    />
  );
}

function PageTitle({ className, ...props }: React.ComponentProps<'h1'>) {
  return (
    <h1
      data-slot="page-title"
      className={cn('font-heading text-[34px] leading-10 font-semibold tracking-[-0.02em]', className)}
      {...props}
    />
  );
}

function PageDescription({ className, ...props }: React.ComponentProps<'p'>) {
  return <p data-slot="page-description" className={cn('mt-1.5 max-w-[640px] text-[15px] leading-[22px] text-ink-2', className)} {...props} />;
}

function PageActions({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="page-actions" className={cn('flex flex-wrap gap-2', className)} {...props} />;
}

export { PageActions, PageDescription, PageHeader, PageTitle };
