'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ChevronRight } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { cn } from 'cn';
import { AppSidebar, NAV, isActive } from '@/components/app-sidebar';
import { NewProjectForm } from '@/components/new-project-form';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { post } from '@/lib/api';
import { selectProject, useProject } from '@/lib/project';
import { useBudget, useMe, useProjects } from '@/lib/queries';
import { useMounted } from '@/lib/use-mounted';

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

const NEW_PROJECT = '__new__';

/** Project switcher; the last item opens the new-project form. */
function ProjectSwitcher() {
  const projects = useProjects().data ?? [];
  const project = useProject();
  const [creating, setCreating] = useState(false);
  // the stored selection is read on the client only: render after hydration
  if (!useMounted() || !project) return <span className="truncate">Office</span>;
  const items = [...projects.map((p) => ({ value: p.id, label: p.name })), { value: NEW_PROJECT, label: 'New project…' }];
  return (
    <div className="relative">
      <Select items={items} value={project.id} onValueChange={(v) => (v === NEW_PROJECT ? setCreating(true) : selectProject(String(v)))}>
        <SelectTrigger size="sm" aria-label="Project" className="border-0 text-ink-3 hover:text-ink">
          <SelectValue />
        </SelectTrigger>
        <SelectContent align="start">
          {items.map((i) => (
            <SelectItem key={i.value} value={i.value}>
              {i.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {creating && (
        <div className="absolute top-full left-0 z-50 mt-2">
          <NewProjectForm onDone={() => setCreating(false)} />
        </div>
      )}
    </div>
  );
}

function AppHeader() {
  const pathname = usePathname();
  const project = useProject();
  const me = useMe();
  const page = NAV.find((n) => isActive(pathname, n.href))?.label ?? (pathname.startsWith('/tasks') ? 'Tasks' : 'Office');
  const email = me.data && 'email' in me.data ? me.data.email : '';
  const logout = async () => {
    await post('/auth/logout');
    window.location.assign('/login');
  };
  return (
    <header className="glass flex min-h-16 flex-wrap items-center gap-x-5 gap-y-3 rounded-[20px] py-2.5 pr-3 pl-5">
      <div className="flex min-w-0 flex-1 items-center gap-2 text-ink-3">
        <ProjectSwitcher />
        <ChevronRight className="size-3.5 shrink-0" aria-hidden />
        <span className="font-medium text-ink">{page}</span>
      </div>
      <BudgetBar projectId={project?.id} />
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
