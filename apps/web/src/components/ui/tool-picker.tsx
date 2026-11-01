'use client';

import { ALWAYS_ON_TOOLS, BUILTIN_TOOLS } from '@office/shared';
import { cn } from 'cn';
import { Checkbox } from './checkbox';

const PILL =
  'inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-lg border border-white/22 bg-white/6 px-2 font-mono text-xs text-ink-2 transition-colors hover:bg-white/10 has-checked:border-violet/50 has-checked:bg-violet/15 has-checked:text-ink has-disabled:cursor-default has-disabled:opacity-60';

/**
 * Built-in Claude Code tools as toggle pills. With `lockAlwaysOn` the always-on tools (Read, Glob, Grep)
 * show checked and locked and are not part of `value`; without it they are ordinary toggles.
 */
function ToolPicker({
  value,
  onChange,
  lockAlwaysOn = false,
  className,
}: {
  value: string[];
  onChange: (tools: string[]) => void;
  lockAlwaysOn?: boolean;
  className?: string;
}) {
  const toggle = (t: string, on: boolean) => onChange(on ? [...value, t] : value.filter((x) => x !== t));
  const tools: readonly string[] = lockAlwaysOn ? BUILTIN_TOOLS : [...ALWAYS_ON_TOOLS, ...BUILTIN_TOOLS];
  return (
    <div data-slot="tool-picker" className={cn('flex flex-wrap gap-1.5', className)}>
      {lockAlwaysOn &&
        ALWAYS_ON_TOOLS.map((t) => (
          <label key={t} className={PILL} title="Always available">
            <Checkbox checked disabled readOnly aria-label={`${t} (always on)`} />
            {t}
          </label>
        ))}
      {tools.map((t) => (
        <label key={t} className={PILL}>
          <Checkbox checked={value.includes(t)} onChange={(e) => toggle(t, e.target.checked)} aria-label={t} />
          {t}
        </label>
      ))}
    </div>
  );
}

export { ToolPicker };
