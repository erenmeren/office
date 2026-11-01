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
    },
    defaultVariants: { size: 'sm' },
  },
);

interface AgentAvatarProps extends React.ComponentProps<'span'>, VariantProps<typeof avatarVariants> {
  name: string;
  /** Slug or role; picks the gradient. Defaults to the name. */
  identity?: string;
}

function AgentAvatar({ name, identity, size, className, style, ...props }: AgentAvatarProps) {
  const [from, to] = agentGradient(identity ?? name);
  return (
    <span
      aria-hidden
      data-slot="agent-avatar"
      className={cn(avatarVariants({ size }), className)}
      style={{ background: `linear-gradient(135deg, ${from}, ${to})`, ...style }}
      {...props}
    >
      {initials(name)}
    </span>
  );
}

export { AgentAvatar, avatarVariants };
