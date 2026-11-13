'use client';

import { Pencil, Plus, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
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
  /** given: the tab in front can be renamed (a pencil, or a double click on its name) */
  onRename?: (id: string, name: string) => void;
  /** more buttons after the one that opens a tab */
  actions?: React.ReactNode;
}

const FOCUS = 'outline-none focus-visible:ring-3 focus-visible:ring-ring/50';

/** A row of tabs that can each be closed, with a button at the end that opens a new one. */
function TabBar({ label, tabs, current, onSelect, onClose, onAdd, addLabel, onRename, actions, className, ...props }: TabBarProps) {
  const list = useRef<HTMLUListElement>(null);
  const [editing, setEditing] = useState<{ id: string; name: string }>();
  // Enter and a click elsewhere both end the edit; the name is kept once
  const kept = useRef(false);
  const edit = (t: { id: string; label: string }) => {
    kept.current = false;
    setEditing({ id: t.id, name: t.label });
  };
  const keep = (was: string) => {
    if (!editing || kept.current) return;
    kept.current = true;
    const name = editing.name.trim();
    setEditing(undefined);
    if (name && name !== was) onRename?.(editing.id, name);
  };
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
            {editing?.id === t.id ? (
              <input
                autoFocus
                aria-label="Tab name"
                value={editing.name}
                maxLength={60}
                onChange={(e) => setEditing({ id: t.id, name: e.target.value })}
                onBlur={() => keep(t.label)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') keep(t.label);
                  if (e.key === 'Escape') {
                    kept.current = true;
                    setEditing(undefined);
                  }
                }}
                className={cn('mx-1 h-7 w-44 rounded-md border border-white/22 bg-white/10 px-2 text-[13px] text-ink', FOCUS)}
              />
            ) : (
              <button
                type="button"
                aria-current={t.id === current ? 'true' : undefined}
                onClick={() => onSelect(t.id)}
                onDoubleClick={onRename && (() => edit(t))}
                className={cn('h-full max-w-[200px] truncate rounded-l-xl pr-1.5 pl-3 font-medium hover:text-ink', FOCUS)}
              >
                {t.label}
              </button>
            )}
            {onRename && t.id === current && editing?.id !== t.id && (
              <button
                type="button"
                aria-label={`Rename ${t.label}`}
                onClick={() => edit(t)}
                className={cn('grid size-7 place-items-center rounded-lg text-ink-3 hover:bg-white/10 hover:text-ink', FOCUS)}
              >
                <Pencil className="size-3" aria-hidden />
              </button>
            )}
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
      {actions}
    </nav>
  );
}

export { TabBar };
