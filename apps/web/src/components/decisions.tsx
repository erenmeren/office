'use client';

import Link from 'next/link';
import { useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ClipboardCheck } from 'lucide-react';
import { ApprovalCard } from '@/components/approval-card';
import { SkillReviewBanners } from '@/components/skill-review-banner';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { StatusPill } from '@/components/ui/status-pill';
import { TypeTag } from '@/components/ui/type-tag';
import { post } from '@/lib/api';
import { approvalSentence } from '@/lib/missions';
import { useProject } from '@/lib/project';
import { useAgents, useApprovals, useMemory, useMissions, useOverview, useSkills, useTasks, type MemoryEntry } from '@/lib/queries';
import { useConfirm } from '@/components/ui/confirm-dialog';

/** Every query a decision can change. */
const KEYS = ['approvals', 'missions', 'overview', 'skills', 'memory', 'tasks', 'task', 'sessions'];

function useDecide() {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const run = async (calls: (() => Promise<unknown>)[]) => {
    setBusy(true);
    setError('');
    const failed: string[] = [];
    for (const call of calls) {
      try {
        await call();
      } catch (err) {
        failed.push(String(err));
      }
    }
    setBusy(false);
    if (failed.length) setError(failed.length === 1 ? failed[0] : `${failed.length} of ${calls.length} failed. ${failed[0]}`);
    await Promise.all(KEYS.map((k) => qc.invalidateQueries({ queryKey: [k] })));
  };
  return { busy, error, run };
}

function Section({ title, count, hint, action, children }: { title: string; count: number; hint: string; action?: ReactNode; children: ReactNode }) {
  if (count === 0) return null;
  return (
    <section aria-label={title} className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="font-heading text-lg font-semibold">{title}</h2>
        <span className="grid h-5 min-w-5 place-items-center rounded-full bg-amber/20 px-1.5 font-mono text-xs font-semibold text-amber">{count}</span>
        <span className="text-[12.5px] text-ink-3">{hint}</span>
        <div className="ml-auto flex gap-2">{action}</div>
      </div>
      {children}
    </section>
  );
}

function TaskDecisionCard({ id, title, note, missionId }: { id: string; title: string; note: string; missionId?: string | null }) {
  const { busy, error, run } = useDecide();
  const decide = (path: 'done' | 'reopen' | 'failed') => () => run([() => post(`/tasks/${id}/${path}`)]);
  return (
    <Card id={`task-${id}`} className="border-amber/45">
      <CardHeader>
        <div className="flex flex-wrap items-center gap-3">
          <CardTitle>{title}</CardTitle>
          <StatusPill status="review" />
        </div>
        <CardDescription className="text-ink-2">Chief could not close this task and left it to you:</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="max-w-prose text-sm whitespace-pre-wrap text-ink">{note}</p>
        <div className="flex flex-wrap gap-2">
          <Button disabled={busy} onClick={decide('reopen')}>
            Reopen (run it again)
          </Button>
          <Button variant="secondary" disabled={busy} onClick={decide('done')}>
            Mark done
          </Button>
          <Button variant="destructive" disabled={busy} onClick={decide('failed')}>
            Failed
          </Button>
          <Button variant="outline" nativeButton={false} render={<Link href={`/mission-control?${missionId ? `mission=${missionId}&` : ''}task=${id}`} />}>
            Open in Mission Control
          </Button>
        </div>
        <p className="text-xs text-ink-3">Reopen when you fixed what the note asks for; it does not use one of the task&apos;s attempts.</p>
        {error && <p className="text-sm text-destructive">{error}</p>}
      </CardContent>
    </Card>
  );
}

function MemoryProposalRow({ e, agentName }: { e: MemoryEntry; agentName?: string }) {
  const { busy, error, run } = useDecide();
  return (
    <li className="flex flex-wrap items-start gap-3 py-3">
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <TypeTag type={e.type} />
          <span className="font-medium text-ink">{e.title}</span>
          {agentName && <span className="text-xs text-ink-3">proposed by {agentName}</span>}
        </div>
        <p className="line-clamp-3 text-sm whitespace-pre-wrap text-ink-2">{e.content}</p>
        {error && <p className="text-sm text-destructive">{error}</p>}
      </div>
      <div className="flex gap-2">
        <Button size="sm" disabled={busy} onClick={() => run([() => post(`/memory/${e.id}/verify`)])}>
          Verify
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => run([() => post(`/memory/${e.id}/reject`)])}>
          Reject
        </Button>
        <Button size="sm" variant="outline" nativeButton={false} render={<Link href="/memory" />}>
          Open
        </Button>
      </div>
    </li>
  );
}

/** Everything waiting for the owner, decidable in place: plan and tool approvals, review-blocked tasks, skill imports, memory proposals. */
export function Decisions() {
  const project = useProject();
  const projectId = project?.id;
  const agents = useAgents();
  const tasks = useTasks();
  const missions = useMissions(projectId);
  const approvals = useApprovals(projectId, 'pending');
  const overview = useOverview(projectId);
  const skills = useSkills();
  const memory = useMemory(projectId, { status: 'proposed' });
  const all = useDecide();
  const confirm = useConfirm();

  const agentName = (agentId?: string | null) => agents.data?.find((a) => a.id === agentId)?.name;
  const taskAgent = (taskId: string | null) => tasks.data?.find((t) => t.id === taskId)?.agentId;
  const plans = (approvals.data ?? []).filter((a) => a.type === 'plan');
  const tools = (approvals.data ?? []).filter((a) => a.type !== 'plan');
  const taskDecisions = (overview.data?.attention ?? []).filter((a) => a.kind === 'task_decision');
  const pendingSkills = (skills.data ?? []).filter((s) => s.status === 'pending_review');
  const proposals = memory.data ?? [];
  const total = plans.length + tools.length + taskDecisions.length + pendingSkills.length + proposals.length;
  const safe = tools.length + pendingSkills.length + proposals.length;

  const approveAll = (ids: string[]) => () => all.run(ids.map((id) => () => post(`/approvals/${id}/approve`, { scope: 'once' })));
  const verifyAllSafe = async () => {
    const parts = [
      tools.length && `approve ${tools.length} tool request${tools.length === 1 ? '' : 's'} once`,
      pendingSkills.length && `approve ${pendingSkills.length} skill import${pendingSkills.length === 1 ? '' : 's'}`,
      proposals.length && `verify ${proposals.length} memory proposal${proposals.length === 1 ? '' : 's'}`,
    ].filter(Boolean);
    if (!(await confirm({ title: 'Verify all safe items?', body: `This will ${parts.join(', ')}. Plans and task decisions are left to you.`, confirmLabel: 'Verify all' }))) return;
    void all.run([
      ...tools.map((a) => () => post(`/approvals/${a.id}/approve`, { scope: 'once' })),
      ...pendingSkills.map((s) => () => post(`/skills/${s.id}/approve`)),
      ...proposals.map((e) => () => post(`/memory/${e.id}/verify`)),
    ]);
  };

  const loaded = approvals.isFetched && overview.isFetched && skills.isFetched && memory.isFetched;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <p className="text-sm text-ink-2">
          {loaded ? (total === 0 ? 'Nothing is waiting for you.' : `${total} item${total === 1 ? '' : 's'} wait for your decision. Agents stay paused until you decide.`) : 'Loading…'}
        </p>
        {safe > 0 && (
          <Button className="ml-auto" disabled={all.busy} onClick={verifyAllSafe}>
            <ClipboardCheck aria-hidden />
            Verify all ({safe})
          </Button>
        )}
      </div>
      {all.error && <p className="text-sm text-destructive">{all.error}</p>}

      <Section title="Plans to approve" count={plans.length} hint="Chief wrote a plan; tasks start only after you approve it.">
        <div className="space-y-3">
          {plans.map((a) => {
            const mission = missions.data?.find((m) => m.id === a.missionId);
            return (
              <Card key={a.id} className="border-amber/45">
                <CardHeader>
                  <CardTitle>{mission?.title ?? 'Mission plan'}</CardTitle>
                  <CardDescription className="text-ink-2">{approvalSentence(a, 'Chief')}</CardDescription>
                  <CardAction className="flex gap-2">
                    <Button nativeButton={false} render={<Link href={`/mission-control?mission=${a.missionId ?? ''}`} />}>
                      Review plan
                    </Button>
                    <Button variant="secondary" disabled={all.busy} onClick={approveAll([a.id])}>
                      Approve plan
                    </Button>
                    <Button variant="destructive" disabled={all.busy} onClick={() => all.run([() => post(`/approvals/${a.id}/deny`)])}>
                      Deny
                    </Button>
                  </CardAction>
                </CardHeader>
              </Card>
            );
          })}
        </div>
      </Section>

      <Section
        title="Tool requests"
        count={tools.length}
        hint="A session is paused on each of these."
        action={
          <Button size="sm" variant="secondary" disabled={all.busy} onClick={approveAll(tools.map((a) => a.id))}>
            Approve all once
          </Button>
        }
      >
        <div className="space-y-3">
          {tools.map((a) => (
            <ApprovalCard key={a.id} approval={a} agentName={agentName(taskAgent(a.taskId)) ?? 'An agent'} />
          ))}
        </div>
      </Section>

      <Section title="Tasks waiting for your decision" count={taskDecisions.length} hint="Chief's review stopped on something only you can change.">
        <div className="space-y-3">
          {taskDecisions.map((t) => (
            <TaskDecisionCard key={t.id} id={t.id} title={t.title} note={t.detail} missionId={t.missionId} />
          ))}
        </div>
      </Section>

      <Section
        title="Skill imports"
        count={pendingSkills.length}
        hint="Imported skills are untrusted until you approve them."
        action={
          <Button size="sm" variant="secondary" disabled={all.busy} onClick={() => all.run(pendingSkills.map((s) => () => post(`/skills/${s.id}/approve`)))}>
            Approve all
          </Button>
        }
      >
        <SkillReviewBanners />
      </Section>

      <Section
        title="Memory proposals"
        count={proposals.length}
        hint="Agents proposed these for the project memory."
        action={
          <Button size="sm" variant="secondary" disabled={all.busy} onClick={() => all.run(proposals.map((e) => () => post(`/memory/${e.id}/verify`)))}>
            Verify all
          </Button>
        }
      >
        <Card>
          <CardContent>
            <ul aria-label="Memory proposals" className="divide-y divide-white/8">
              {proposals.map((e) => (
                <MemoryProposalRow key={e.id} e={e} agentName={agentName(e.authorAgentId)} />
              ))}
            </ul>
          </CardContent>
        </Card>
      </Section>
    </div>
  );
}
