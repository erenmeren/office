'use client';

import { useSyncExternalStore } from 'react';
import { useProjects } from '@/lib/queries';
import { setTabs, showProject, useTabs } from '@/lib/tabs';
import { useMounted } from '@/lib/use-mounted';

const KEY = 'office.projectId';
const listeners = new Set<() => void>();
const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};
const read = () => localStorage.getItem(KEY);

/** Selects the project the UI shows and brings its tab to the front, reopening a closed one; persisted in localStorage so a reload keeps it. */
export function selectProject(id: string) {
  if (id) {
    localStorage.setItem(KEY, id);
    setTabs((tabs) => showProject(tabs, id));
  } else localStorage.removeItem(KEY);
  listeners.forEach((fn) => fn());
}

/** The selected project; with nothing or a deleted project stored, the first one whose tab is open, else the first. */
export function useProject() {
  const projects = useProjects().data;
  const stored = useSyncExternalStore(subscribe, read, () => null);
  const { closed } = useTabs();
  // none while the page hydrates: the server rendered without one, and the project list may already be here by then
  if (!useMounted()) return undefined;
  return projects?.find((p) => p.id === stored) ?? projects?.find((p) => !closed.includes(p.id)) ?? projects?.[0];
}
