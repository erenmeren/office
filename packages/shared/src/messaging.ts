import { z } from 'zod';

export const ConversationKindSchema = z.enum(['direct', 'group', 'task', 'human']);
export type ConversationKind = z.infer<typeof ConversationKindSchema>;

export const MessageTypeSchema = z.enum([
  'message',
  'question',
  'reply',
  'handoff',
  'help_request',
  'escalation',
  'artifact',
]);
export type MessageType = z.infer<typeof MessageTypeSchema>;

export const DeliveryStatusSchema = z.enum(['pending', 'delivered', 'acknowledged']);
export type DeliveryStatus = z.infer<typeof DeliveryStatusSchema>;

// A `reply` to a waiting run resumes it; it does not create an inbox run.
export const WAKE_TYPES: MessageType[] = ['question', 'help_request', 'handoff', 'escalation'];

export const MessageLimitsSchema = z.object({
  perSession: z.number().int().positive().default(20),
  perTask: z.number().int().positive().default(100),
  escalationDepth: z.number().int().nonnegative().default(2),
  handoffChain: z.number().int().nonnegative().default(3),
});
export type MessageLimits = z.infer<typeof MessageLimitsSchema>;

export const MessageViewSchema = z.object({
  id: z.string(),
  conversationId: z.string(),
  projectId: z.string(),
  type: MessageTypeSchema,
  body: z.string(),
  createdAt: z.iso.datetime(),
  senderAgentId: z.string().nullable(),
  senderUserId: z.string().nullable(),
  taskId: z.string().nullable(),
  inReplyToId: z.string().nullable(),
  deliveries: z.array(
    z.object({
      recipientAgentId: z.string().nullable(),
      recipientUserId: z.string().nullable(),
      status: DeliveryStatusSchema,
    }),
  ),
});
export type MessageView = z.infer<typeof MessageViewSchema>;
