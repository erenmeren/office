'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Bot, Database, FolderGit2, LayoutDashboard, MessagesSquare, Radio, ScrollText, Server, Settings2, Sparkles, Target, type LucideIcon } from 'lucide-react';
import { cn } from 'cn';
import { AgentAvatar } from '@/components/ui/agent-avatar';
import { StatusDot } from '@/components/ui/status-pill';
import { useProject } from '@/lib/project';
import { useAgents, useApprovals, useConversations, useLiveSessions, useMemoryCounts, useSkills, useTasks, useWorkers } from '@/lib/queries';

export const NAV: { href: string; label: string; icon: LucideIcon }[] = [
  { href: '/', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/mission-control', label: 'Mission Control', icon: Target },
  { href: '/sessions', label: 'Live Sessions', icon: Radio },
  { href: '/conversations', label: 'Conversations', icon: MessagesSquare },
  { href: '/agents', label: 'Agent Studio', icon: Bot },
  { href: '/skills', label: 'Skill Library', icon: Sparkles },
  { href: '/memory', label: 'Project Memory', icon: Database },
  { href: '/workers', label: 'Workers', icon: Server },
  { href: '/audit', label: 'Audit', icon: ScrollText },
  { href: '/settings', label: 'Settings', icon: Settings2 },
];

export const isActive = (pathname: string, href: string) => (href === '/' ? pathname === '/' : pathname.startsWith(href));

function BrandMark() {
  return (
    <svg aria-hidden width="30" height="30" viewBox="0 0 28 28" className="shrink-0 drop-shadow-[0_4px_12px_rgba(139,92,246,.6)]">
      <defs>
        <linearGradient id="brand-mark" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#b39dff" />
          <stop offset="1" stopColor="#4fe3ff" />
        </linearGradient>
      </defs>
      <rect width="28" height="28" rx="9" fill="url(#brand-mark)" />
      <path d="M9 10.5H19M9 10.5 14 19M19 10.5 14 19" stroke="#0b0820" strokeWidth="1.6" strokeLinecap="round" fill="none" />
      <circle cx="9" cy="10.5" r="2.6" fill="#0b0820" />
      <circle cx="19" cy="10.5" r="2.6" fill="#0b0820" />
      <circle cx="14" cy="19" r="2.6" fill="#0b0820" />
    </svg>
  );
}

function Count({ n, tone }: { n: number; tone: 'live' | 'decision' | 'message' }) {
  if (!n) return null;
  const color = { live: 'bg-mint/20 text-mint', decision: 'bg-amber/20 text-amber', message: 'bg-pink/20 text-pink' }[tone];
  return <span className={cn('ml-auto grid h-5 min-w-5 place-items-center rounded-full px-1.5 font-mono text-xs font-semibold', color)}>{n}</span>;
}

/** Badges per nav item, from live data: approvals waiting, live sessions, skills to review, workers online. */
export function useNavCounts() {
  const skills = useSkills();
  const workers = useWorkers();
  const projectId = useProject()?.id;
  const conversations = useConversations(projectId);
  const memory = useMemoryCounts(projectId);
  const approvals = useApprovals(projectId, 'pending');
  const sessions = useLiveSessions(projectId);
  return {
    '/mission-control': { n: approvals.data?.length ?? 0, tone: 'decision' as const },
    '/sessions': { n: sessions.data?.length ?? 0, tone: 'live' as const },
    '/conversations': { n: conversations.data?.reduce((n, c) => n + c.unreadForOwner, 0) ?? 0, tone: 'message' as const },
    '/skills': { n: skills.data?.filter((s) => s.status === 'pending_review').length ?? 0, tone: 'decision' as const },
    '/memory': { n: memory.data?.proposed ?? 0, tone: 'decision' as const },
    '/workers': { n: workers.data?.filter((w) => w.status === 'online').length ?? 0, tone: 'live' as const },
  } as Record<string, { n: number; tone: 'live' | 'decision' | 'message' }>;
}

export function AppSidebar({ className }: { className?: string }) {
  const pathname = usePathname();
  const agents = useAgents();
  const tasks = useTasks();
  const counts = useNavCounts();
  const project = useProject();
  const busy = new Set(tasks.data?.filter((t) => t.status === 'running').map((t) => t.agentId));

  return (
    <aside className={cn('glass my-4 ml-4 flex w-[232px] shrink-0 flex-col gap-5 self-start rounded-[22px] px-3 py-4', className)}>
      <div className="flex h-[34px] items-center gap-2.5 px-1">
        <BrandMark />
        <span className="font-heading text-[19px] font-semibold tracking-[-0.01em]">Agent Office</span>
      </div>

      <Link href="/tasks/new" className="flex h-14 items-center gap-2.5 rounded-[14px] border border-white/13 bg-white/7 px-3 hover:bg-white/10">
        <FolderGit2 className="size-4 shrink-0 text-ink-3" aria-hidden />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="text-xs text-ink-3">Project</span>
          <span className="truncate font-medium">{project?.name ?? 'No project yet'}</span>
        </span>
      </Link>

      <nav aria-label="Primary" className="flex flex-col gap-[3px]">
        {NAV.map(({ href, label, icon: Icon }) => {
          const active = isActive(pathname, href);
          const c = counts[href];
          return (
            <Link
              key={href}
              href={href}
              aria-current={active ? 'page' : undefined}
              className={cn(
                'flex h-[42px] items-center gap-2.5 rounded-xl border border-transparent px-3 font-medium text-ink-2 hover:bg-white/7 hover:text-ink',
                active &&
                  'border-violet/50 bg-linear-to-r from-violet/40 to-cyan/14 text-ink shadow-[0_0_28px_rgba(139,92,246,.28),inset_0_1px_0_rgba(255,255,255,.18)]',
              )}
            >
              <Icon className="size-[18px] shrink-0" aria-hidden />
              {label}
              {c && <Count n={c.n} tone={c.tone} />}
            </Link>
          );
        })}
      </nav>

      <div className="flex flex-col gap-0.5">
        <div className="px-3 pb-1.5 text-xs font-semibold tracking-[0.04em] uppercase text-ink-3">Team</div>
        {agents.data?.map((a) => (
          <Link key={a.id} href={`/agents/${a.id}`} className="flex h-[38px] items-center gap-2.5 rounded-[10px] px-2.5 text-ink-2 hover:bg-white/7">
            <AgentAvatar name={a.name} identity={a.slug} size="sm" />
            <span className="min-w-0 flex-1 truncate">{a.name}</span>
            <StatusDot tone={busy.has(a.id) ? 'live' : 'idle'} />
          </Link>
        ))}
      </div>
    </aside>
  );
}
