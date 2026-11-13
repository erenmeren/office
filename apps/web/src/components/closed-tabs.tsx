'use client';

import { History } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button, buttonWrap } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { selectProject } from '@/lib/project';
import { useProjects, useTalks } from '@/lib/queries';
import { useSimpleMode } from '@/lib/simple-mode';
import { openFresh, setTabs, useTabs } from '@/lib/tabs';

/** The tabs that are not open: the projects whose tab was closed, and the earlier talks that have no project. */
function useClosedTabs() {
  const projects = useProjects().data ?? [];
  const talks = useTalks().data ?? [];
  const { closed, fresh } = useTabs();
  return { projects: projects.filter((p) => closed.includes(p.id)), talks: talks.filter((t) => !fresh.includes(t.id)) };
}

/** One button per closed tab; picking one opens it again, in front. Closing a tab deletes nothing, so all of them are here. */
export function ClosedTabsList({ onPick }: { onPick?: () => void }) {
  const { projects, talks } = useClosedTabs();
  const router = useRouter();
  const simple = useSimpleMode();
  const talk = (id: string) => {
    setTabs((tabs) => openFresh(tabs, id));
    // a talk is shown on the assistant's page
    router.push(simple ? '/' : '/conductor');
    onPick?.();
  };
  return (
    <div className="flex flex-col items-start gap-2">
      {projects.length > 0 && <p className="text-[13px] text-ink-3">Tabs you closed:</p>}
      {projects.map((p) => (
        <Button
          key={p.id}
          variant="secondary"
          size="sm"
          className={buttonWrap}
          onClick={() => {
            selectProject(p.id);
            onPick?.();
          }}
        >
          {p.name}
        </Button>
      ))}
      {talks.length > 0 && <p className="text-[13px] text-ink-3">Earlier talks:</p>}
      {talks.map((t) => (
        <Button key={t.id} variant="secondary" size="sm" className={buttonWrap} onClick={() => talk(t.id)}>
          {t.title}
        </Button>
      ))}
    </div>
  );
}

/** The tab row's way back to a closed tab: a button that says how many there are, and their list. */
export function ClosedTabs() {
  const { projects, talks } = useClosedTabs();
  const [open, setOpen] = useState(false);
  const count = projects.length + talks.length;
  if (count === 0) return null;
  return (
    <>
      <Button variant="ghost" size="sm" aria-label={`Closed tabs (${count})`} onClick={() => setOpen(true)}>
        <History data-icon="inline-start" aria-hidden />
        <span className="hidden sm:inline">Closed tabs</span> ({count})
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogTitle>Closed tabs</DialogTitle>
          <ClosedTabsList onPick={() => setOpen(false)} />
        </DialogContent>
      </Dialog>
    </>
  );
}
