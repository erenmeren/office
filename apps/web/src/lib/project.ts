'use client';

import { useSyncExternalStore } from 'react';
import { useProjects } from '@/lib/queries';

const KEY = 'office.projectId';
const listeners = new Set<() => void>();
const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};
const read = () => localStorage.getItem(KEY);

/** Selects the project the UI shows; persisted in localStorage so a reload keeps it. */
export function selectProject(id: string) {
  localStorage.setItem(KEY, id);
  listeners.forEach((fn) => fn());
}

/** The selected project (falls back to the first one when nothing or a deleted project is stored). */
export function useProject() {
  const projects = useProjects().data;
  const stored = useSyncExternalStore(subscribe, read, () => null);
  return projects?.find((p) => p.id === stored) ?? projects?.[0];
}
