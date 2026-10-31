import { z } from 'zod';
import { EventType } from './enums.js';

export const OfficeEventSchema = z.object({
  type: EventType,
  seq: z.number().int().positive(),
  ts: z.iso.datetime(),
  sessionId: z.string(),
  runId: z.string(),
  agentId: z.string(),
  projectId: z.string(),
  payload: z.record(z.string(), z.unknown()),
});
export type OfficeEvent = z.infer<typeof OfficeEventSchema>;

export type EventBody = Pick<OfficeEvent, 'type' | 'payload'>;
