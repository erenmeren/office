'use client';

import { useSyncExternalStore } from 'react';

const KEY = 'office.simple';
const listeners = new Set<() => void>();
const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};

/** Simple view (the default) shows the few pages a newcomer needs; the other view shows every page. Kept in localStorage. */
export function setSimpleMode(simple: boolean) {
  localStorage.setItem(KEY, simple ? '1' : '0');
  listeners.forEach((fn) => fn());
}

export const useSimpleMode = () =>
  useSyncExternalStore(
    subscribe,
    () => localStorage.getItem(KEY) !== '0',
    () => true,
  );
