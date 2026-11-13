'use client';

import { Plus, X } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { cn } from 'cn';

interface TabBarProps extends Omit<React.ComponentProps<'nav'>, 'onSelect'> {
  /** names the row for assistive technology */
  label: string;
  tabs: { id: string; label: string }[];
  current?: string;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onAdd: () => void;
  addLabel: string;
}

const FOCUS = 'outline-none focus-visible:ring-3 focus-visible:ring-ring/50';

/** A row of tabs that can each be closed, with a button at the end that opens a new one. */
function TabBar({ label, tabs, current, onSelect, onClose, onAdd, addLabel, className, ...props }: TabBarProps) {
  const list = useRef<HTMLUListElement>(null);
  // more tabs than fit: the row scrolls sideways (never the page), and the tab in front stays in sight
  useEffect(() => {
    const row = list.current;
    const tab = row?.querySelector<HTMLElement>('[aria-current="true"]')?.parentElement;
    if (row && tab) row.scrollLeft = tab.offsetLeft - (row.clientWidth - tab.offsetWidth) / 2;
  }, [current, tabs.length]);
  return (
    <nav aria-label={label} data-slot="tab-bar" className={cn('flex min-h-9 min-w-0 items-center gap-1', className)} {...props}>
      <ul ref={list} className="relative flex min-w-0 items-center gap-1 overflow-x-auto">
        {tabs.map((t) => (
          <li
            key={t.id}
            className={cn(
              'flex h-9 shrink-0 items-center rounded-xl border border-transparent text-[13px] text-ink-2 hover:bg-white/6',
              t.id === current && 'border-white/13 bg-white/10 text-ink shadow-[inset_0_1px_0_rgba(255,255,255,.18)]',
            )}
          >
            <button
              type="button"
              aria-current={t.id === current ? 'true' : undefined}
              onClick={() => onSelect(t.id)}
              className={cn('h-full max-w-[200px] truncate rounded-l-xl pr-1.5 pl-3 font-medium hover:text-ink', FOCUS)}
            >
              {t.label}
            </button>
            <button
              type="button"
              aria-label={`Close ${t.label}`}
              onClick={() => onClose(t.id)}
              className={cn('mr-1 grid size-7 place-items-center rounded-lg text-ink-3 hover:bg-white/10 hover:text-ink', FOCUS)}
            >
              <X className="size-3.5" aria-hidden />
            </button>
          </li>
        ))}
      </ul>
      <button type="button" aria-label={addLabel} onClick={onAdd} className={cn('grid size-9 shrink-0 place-items-center rounded-xl text-ink-2 hover:bg-white/10 hover:text-ink', FOCUS)}>
        <Plus className="size-4" aria-hidden />
      </button>
    </nav>
  );
}

export { TabBar };
