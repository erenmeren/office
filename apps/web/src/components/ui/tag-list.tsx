import { cn } from 'cn';

/** A row of small chips; renders a dash when empty. */
function TagList({ tags, className }: { tags: string[]; className?: string }) {
  if (!tags.length) return <span className="text-ink-3">—</span>;
  return (
    <ul data-slot="tag-list" className={cn('flex flex-wrap gap-1.5', className)}>
      {tags.map((t) => (
        <li key={t} className="inline-flex h-5 items-center rounded-md border border-white/22 bg-white/8 px-1.5 font-mono text-[11px] text-ink-2">
          {t}
        </li>
      ))}
    </ul>
  );
}

export { TagList };
