import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from 'cn';

const bubbleVariants = cva('max-w-[min(100%,560px)] rounded-2xl border px-3.5 py-2.5 text-sm leading-[22px] whitespace-pre-wrap', {
  variants: {
    from: {
      agent: 'border-white/13 bg-white/7',
      owner: 'border-pink/35 bg-pink/12',
    },
  },
  defaultVariants: { from: 'agent' },
});

interface MessageBubbleProps extends Omit<React.ComponentProps<'article'>, 'children'>, VariantProps<typeof bubbleVariants> {
  avatar: React.ReactNode;
  /** "Chief to QA" */
  heading: string;
  time: string;
  typeLabel: string;
  body: string;
  delivery?: string;
}

function MessageBubble({ avatar, heading, time, typeLabel, body, delivery, from, className, ...props }: MessageBubbleProps) {
  return (
    <article data-slot="message-bubble" className={cn('flex gap-2.5', from === 'owner' && 'flex-row-reverse', className)} {...props}>
      {avatar}
      <div className={cn('flex min-w-0 flex-col gap-1', from === 'owner' && 'items-end')}>
        <div className="flex flex-wrap items-center gap-2 text-xs text-ink-2">
          <span className="font-medium text-ink">{heading}</span>
          <span className="font-mono text-ink-3">{time}</span>
          <span className="rounded-full border border-white/22 px-2 text-[11px]">{typeLabel}</span>
        </div>
        <div className={bubbleVariants({ from })}>{body}</div>
        {delivery && <span className="text-[11.5px] text-ink-3">{delivery}</span>}
      </div>
    </article>
  );
}

export { MessageBubble };
