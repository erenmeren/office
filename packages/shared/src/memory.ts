import { z } from 'zod';

export const MemoryTypeSchema = z.enum([
  'decision',
  'convention',
  'api_contract',
  'known_issue',
  'lesson',
  'task_summary',
]);
export type MemoryType = z.infer<typeof MemoryTypeSchema>;

export const MemoryScopeSchema = z.enum(['project', 'agent_project', 'agent']);
export type MemoryScope = z.infer<typeof MemoryScopeSchema>;

export const MemoryStatusSchema = z.enum(['proposed', 'verified', 'rejected']);
export type MemoryStatus = z.infer<typeof MemoryStatusSchema>;

export const MemorySourceKindSchema = z.enum(['event', 'message', 'commit', 'file', 'run', 'task']);
export type MemorySourceKind = z.infer<typeof MemorySourceKindSchema>;

export const MemorySourceInputSchema = z.object({
  kind: MemorySourceKindSchema,
  ref: z.string().min(1),
  label: z.string().optional(),
});
export type MemorySourceInput = z.infer<typeof MemorySourceInputSchema>;

export const MemoryProposalSchema = z.object({
  type: MemoryTypeSchema.exclude(['task_summary']),
  title: z.string().min(1).max(200),
  content: z.string().min(1).max(8000),
  scope: MemoryScopeSchema.default('project'),
  sources: z.array(MemorySourceInputSchema).default([]),
});
export type MemoryProposal = z.infer<typeof MemoryProposalSchema>;
