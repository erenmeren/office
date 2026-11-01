'use client';

import { useEffect, useState } from 'react';
import { cn } from 'cn';
import { countdown } from '@/lib/missions';

/** Live mm:ss until `expiresAt`, ticking every second; renders nothing without a deadline. */
function Countdown({ expiresAt, className, ...props }: { expiresAt: string | null } & Omit<React.ComponentProps<'time'>, 'children'>) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!expiresAt) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [expiresAt]);
  const left = countdown(expiresAt, now);
  if (!left) return null;
  return (
    <time data-slot="countdown" dateTime={expiresAt ?? undefined} className={cn('font-mono tabular-nums', className)} {...props}>
      {left}
    </time>
  );
}

export { Countdown };
