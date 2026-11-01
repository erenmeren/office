import { z } from 'zod';
import { ApprovalTypeSchema } from './enums.js';

export const ApprovalRequestSchema = z.object({
  requestId: z.string(),
  toolName: z.string(),
  input: z.record(z.string(), z.unknown()),
  type: ApprovalTypeSchema,
  reason: z.string(),
});
export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>;

export const ApprovalDecisionSchema = z.object({
  requestId: z.string(),
  decision: z.enum(['allow', 'deny']),
  message: z.string().optional(),
});
export type ApprovalDecision = z.infer<typeof ApprovalDecisionSchema>;
