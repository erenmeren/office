import { cn } from 'cn';
import { AgentAvatar } from '@/components/ui/agent-avatar';

interface ActivityRowProps extends Omit<React.ComponentProps<'li'>, 'children'> {
  ts: string;
  actor: string;
  type: string;
  detail: string;
  /** Agent slug; picks the avatar gradient. */
  identity?: string;
}

/** One line of the activity feed: time, actor, event type, detail. */
function ActivityRow({ ts, actor, type, detail, identity, className, ...props }: ActivityRowProps) {
  return (
    <li data-slot="activity-row" className={cn('flex min-w-0 items-center gap-3 py-2 text-[13px]', className)} {...props}>
      <time dateTime={ts} className="w-[60px] shrink-0 font-mono text-[12px] text-ink-3">
        {new Date(ts).toLocaleTimeString([], { hour12: false })}
      </time>
      <AgentAvatar name={actor} identity={identity} size="sm" />
      <span className="w-[110px] shrink-0 truncate text-ink">{actor}</span>
      <span className="w-[170px] shrink-0 truncate font-mono text-[12px] text-cyan">{type}</span>
      <span className="min-w-0 flex-1 truncate text-ink-2">{detail}</span>
    </li>
  );
}

export { ActivityRow };
