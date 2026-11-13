'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { cn } from 'cn';
import { AppSidebar, NAV, isActive, useNav } from '@/components/app-sidebar';
import { ProjectTabs } from '@/components/project-tabs';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { post } from '@/lib/api';
import { useProject } from '@/lib/project';
import { useBudget, useMe } from '@/lib/queries';

/** Today's spend against the project's daily limit. */
function BudgetBar({ projectId }: { projectId?: string }) {
  const budget = useBudget(projectId).data;
  if (!budget) return null;
  return (
    <div className="flex min-w-[150px] flex-col gap-1.5">
      <span className="font-mono text-[12.5px] whitespace-nowrap text-ink-2">
        Today ${budget.spentTodayUsd.toFixed(2)} / ${budget.dailyBudgetUsd.toFixed(2)}
      </span>
      <Progress value={budget.dailyBudgetUsd ? (budget.spentTodayUsd / budget.dailyBudgetUsd) * 100 : 0} label="Daily budget used" className="h-1" />
    </div>
  );
}

function AppHeader() {
  const pathname = usePathname();
  const project = useProject();
  const me = useMe();
  const nav = useNav();
  // a page outside the simple menu keeps its full name
  const page = (nav.find((n) => isActive(pathname, n.href)) ?? NAV.find((n) => isActive(pathname, n.href)))?.label ?? (pathname.startsWith('/tasks') ? 'Tasks' : 'Office');
  const email = me.data && 'email' in me.data ? me.data.email : '';
  const logout = async () => {
    await post('/auth/logout');
    window.location.assign('/login');
  };
  return (
    <header className="glass flex min-h-16 flex-wrap items-center gap-x-5 gap-y-3 rounded-[20px] py-2.5 pr-3 pl-5">
      <div className="flex min-w-0 flex-1 items-center gap-2 text-ink-3">
        <span className="font-medium text-ink">{page}</span>
      </div>
      <BudgetBar projectId={project?.id} />
      {/* compact nav for viewports without the sidebar */}
      <nav aria-label="Primary (compact)" className="flex gap-1 lg:hidden">
        {nav.map((n) => (
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
        <ProjectTabs className="mb-3" />
        <AppHeader />
        {/* the office floor is a canvas and takes the whole width */}
        <main className={cn('mx-auto w-full flex-1 pt-6', pathname === '/office' ? 'max-w-[2200px]' : 'max-w-7xl')}>{children}</main>
      </div>
    </div>
  );
}
