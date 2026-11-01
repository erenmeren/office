import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from 'cn';
import { agentGradient, initials } from '@/lib/agent-identity';

const avatarVariants = cva(
  'grid shrink-0 place-items-center font-heading font-bold leading-none text-on-brand shadow-[0_4px_14px_rgba(0,0,0,.25),inset_0_1px_0_rgba(255,255,255,.45)]',
  {
    variants: {
      size: {
        sm: 'size-6 rounded-lg text-[10px]',
        md: 'size-10 rounded-xl text-[15px]',
        lg: 'size-11 rounded-[14px] text-[17px]',
      },
      /** A native subagent: a dashed ring in the agent's color, no fill (Live Sessions legend). */
      subagent: { true: 'rounded-full border-[1.5px] border-dashed shadow-none', false: '' },
    },
    defaultVariants: { size: 'sm', subagent: false },
  },
);

interface AgentAvatarProps extends React.ComponentProps<'span'>, VariantProps<typeof avatarVariants> {
  name: string;
  /** Slug or role; picks the gradient. Defaults to the name. */
  identity?: string;
}

function AgentAvatar({ name, identity, size, subagent, className, style, ...props }: AgentAvatarProps) {
  const [from, to] = agentGradient(identity ?? name);
  return (
    <span
      aria-hidden
      data-slot="agent-avatar"
      data-subagent={subagent || undefined}
      className={cn(avatarVariants({ size, subagent }), className)}
      style={{ ...(subagent ? { borderColor: from, color: from } : { background: `linear-gradient(135deg, ${from}, ${to})` }), ...style }}
      {...props}
    >
      {initials(name)}
    </span>
  );
}

export { AgentAvatar, avatarVariants };

/** The owner, in the header's pink "You" style. */
function OwnerAvatar({ className, ...props }: React.ComponentProps<'span'>) {
  return (
    <span
      aria-hidden
      data-slot="owner-avatar"
      className={cn(
        'grid size-6 shrink-0 place-items-center rounded-lg bg-linear-to-br from-pink to-[#ffa66b] font-heading text-[10px] font-bold leading-none text-on-brand',
        className,
      )}
      {...props}
    >
      You
    </span>
  );
}

export { OwnerAvatar };
