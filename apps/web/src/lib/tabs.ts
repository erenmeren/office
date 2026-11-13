'use client';

import { useSyncExternalStore } from 'react';

/**
 * The owner's tabs. Every project has a tab unless the owner closed it (`closed`, project ids); a new tab (`fresh`,
 * the id of its conversation with the assistant) has no project yet. `front` is the new tab in front, null while a
 * project's tab is. Kept in localStorage: closing a tab hides it here and deletes nothing.
 */
export interface Tabs {
  closed: string[];
  fresh: string[];
  front: string | null;
}

const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

export function parseTabs(raw: string | null): Tabs {
  let stored: Partial<Record<keyof Tabs, unknown>> = {};
  try {
    stored = (raw && JSON.parse(raw)) || {};
  } catch {
    // not ours: start with every tab open
  }
  return { closed: strings(stored.closed), fresh: strings(stored.fresh), front: typeof stored.front === 'string' ? stored.front : null };
}

/** The tab in front: a new tab, else the selected project's, else none (that project's tab was closed). */
export function frontTab(tabs: Tabs, project: { id: string } | undefined): { fresh: string } | { project: string } | null {
  if (tabs.front && tabs.fresh.includes(tabs.front)) return { fresh: tabs.front };
  return project && !tabs.closed.includes(project.id) ? { project: project.id } : null;
}

/** Closes a tab: a new tab is forgotten, a project's tab is hidden. */
export function closeTab(tabs: Tabs, id: string): Tabs {
  if (!tabs.fresh.includes(id)) return { ...tabs, closed: [...tabs.closed, id] };
  return { ...tabs, fresh: tabs.fresh.filter((f) => f !== id), front: tabs.front === id ? null : tabs.front };
}

/** The tab that comes forward when `id` is closed: the one to its right, else the one to its left. */
export function neighbour(order: string[], id: string): string | null {
  const i = order.indexOf(id);
  return order[i + 1] ?? order[i - 1] ?? null;
}

/** A project's tab, reopened when it was closed, in front of any new tab. */
export const showProject = (tabs: Tabs, id: string): Tabs => ({ ...tabs, closed: tabs.closed.filter((c) => c !== id), front: null });

export const openFresh = (tabs: Tabs, conversationId: string): Tabs => ({ ...tabs, fresh: [...tabs.fresh, conversationId], front: conversationId });

const KEY = 'office.tabs';
const NONE: Tabs = { closed: [], fresh: [], front: null };
const listeners = new Set<() => void>();
const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};
// useSyncExternalStore needs the same object for the same stored text
let cache: { raw: string | null; tabs: Tabs } | undefined;
const read = () => {
  const raw = localStorage.getItem(KEY);
  if (!cache || cache.raw !== raw) cache = { raw, tabs: parseTabs(raw) };
  return cache.tabs;
};

export function setTabs(change: (tabs: Tabs) => Tabs) {
  localStorage.setItem(KEY, JSON.stringify(change(read())));
  listeners.forEach((fn) => fn());
}

export const useTabs = () => useSyncExternalStore(subscribe, read, () => NONE);
