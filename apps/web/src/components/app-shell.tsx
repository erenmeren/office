'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ChevronRight } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from 'cn';
import { AppSidebar, NAV, isActive } from '@/components/app-sidebar';
import { Button } from '@/components/ui/button';
import { post } from '@/lib/api';
import { useMe, useProjects } from '@/lib/queries';

function AppHeader() {
  const pathname = usePathname();
  const projects = useProjects();
  const me = useMe();
  const page = NAV.find((n) => isActive(pathname, n.href))?.label ?? (pathname.startsWith('/tasks') ? 'Tasks' : 'Office');
  const email = me.data && !me.data.setupRequired ? me.data.email : '';
  const logout = async () => {
    await post('/auth/logout');
    window.location.assign('/login');
  };
  return (
    <header className="glass flex min-h-16 flex-wrap items-center gap-x-5 gap-y-3 rounded-[20px] py-2.5 pr-3 pl-5">
      <div className="flex min-w-0 flex-1 items-center gap-2 text-ink-3">
        <span className="truncate">{projects.data?.[0]?.name ?? 'Office'}</span>
        <ChevronRight className="size-3.5 shrink-0" aria-hidden />
        <span className="font-medium text-ink">{page}</span>
      </div>
      {/* compact nav for viewports without the sidebar */}
      <nav aria-label="Primary (compact)" className="flex gap-1 lg:hidden">
        {NAV.map((n) => (
          <Link
            key={n.href}
            href={n.href}
            aria-label={n.label}
            aria-current={isActive(pathname, n.href) ? 'page' : undefined}
            className={cn('grid size-9 place-items-center rounded-xl text-ink-2 hover:bg-white/10', isActive(pathname, n.href) && 'bg-white/10 text-ink')}
          >
            <n.icon className="size-[18px]" aria-hidden />
          </Link>
        ))}
      </nav>
      <span
        aria-hidden
        className="grid size-10 place-items-center rounded-full bg-linear-to-br from-pink to-[#ffa66b] text-xs font-bold text-on-brand shadow-[0_4px_16px_rgba(255,106,213,.45)]"
      >
        {email ? email[0].toUpperCase() : 'You'}
      </span>
      <Button variant="ghost" size="sm" onClick={logout}>
        Log out
      </Button>
    </header>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  if (pathname === '/login') return <main className="aurora min-h-dvh p-6">{children}</main>;
  return (
    <div className="aurora flex min-h-dvh">
      <AppSidebar className="hidden lg:flex" />
      <div className="flex min-w-0 flex-1 flex-col p-4 pb-12">
        <AppHeader />
        <main className="mx-auto w-full max-w-7xl flex-1 pt-6">{children}</main>
      </div>
    </div>
  );
}
