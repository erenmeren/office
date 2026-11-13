'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { ClosedTabs } from '@/components/closed-tabs';
import { OpenFolder } from '@/components/open-folder';
import { TabBar } from '@/components/ui/tab-bar';
import { del, post, put } from '@/lib/api';
import { selectProject, useProject } from '@/lib/project';
import { useProjects, useTalks } from '@/lib/queries';
import { useSimpleMode } from '@/lib/simple-mode';
import { closeTab, frontTab, neighbour, openFresh, setTabs, useTabs } from '@/lib/tabs';
import { useMounted } from '@/lib/use-mounted';

/**
 * The tabs above every page: one per project, then the new ones the owner opened with +. The tab in front sets the
 * project every page shows; a new tab has none yet and is a talk with the assistant.
 */
export function ProjectTabs({ className }: { className?: string }) {
  const projects = useProjects().data;
  const project = useProject();
  const tabs = useTabs();
  const simple = useSimpleMode();
  const router = useRouter();
  const pathname = usePathname();
  const qc = useQueryClient();
  const mounted = useMounted();
  const talks = useTalks().data;
  // a new tab is named by how the owner began in it, once something is said there
  const name = (id: string) => talks?.find((t) => t.id === id)?.title ?? 'New';
  const assistant = simple ? '/' : '/conductor';
  // a new tab is in front on the assistant's page only: every other page shows the selected project
  const front = frontTab(pathname === assistant ? tabs : { ...tabs, front: null }, project);
  const frontId = front ? ('fresh' in front ? front.fresh : front.project) : undefined;
  // the stored tabs are read on the client only, and the projects arrive a moment later: + works before they do
  const items = mounted ? [...(projects ?? []).filter((p) => !tabs.closed.includes(p.id)).map((p) => ({ id: p.id, label: p.name })), ...tabs.fresh.map((id) => ({ id, label: name(id) }))] : [];
  const select = (id: string) => {
    if (!tabs.fresh.includes(id)) return selectProject(id);
    setTabs((t) => ({ ...t, front: id }));
    // a new tab is a talk with the assistant: show that page
    router.push(assistant);
  };
  const close = (id: string) => {
    const next = id === frontId ? neighbour(items.map((i) => i.id), id) : null;
    setTabs((t) => closeTab(t, id));
    // a new tab nothing was said in leaves no conversation behind; the API keeps every other one
    if (tabs.fresh.includes(id)) void del(`/conductor/tabs/${id}`).catch(() => undefined);
    if (next) select(next);
  };
  const add = async () => {
    // without the assistant there is no new tab: its page says why
    const made = await post<{ conversationId: string }>('/conductor/tabs').catch(() => null);
    if (made) setTabs((t) => openFresh(t, made.conversationId));
    router.push(assistant);
  };
  const rename = async (id: string, name: string) => {
    // a project's tab carries the project's name; a tab without a project has a name of its own
    await (tabs.fresh.includes(id) ? put(`/conductor/tabs/${id}`, { title: name }) : put(`/projects/${id}`, { name })).catch(() => undefined);
    await Promise.all([qc.invalidateQueries({ queryKey: ['projects'] }), qc.invalidateQueries({ queryKey: ['conductor'] })]);
  };
  return (
    <TabBar
      label="Projects"
      tabs={items}
      current={frontId}
      onSelect={select}
      onClose={close}
      onAdd={add}
      addLabel="New tab"
      onRename={(id, name) => void rename(id, name)}
      actions={
        <>
          <OpenFolder />
          <ClosedTabs />
        </>
      }
      className={className}
    />
  );
}
