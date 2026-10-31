import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import type { PrismaClient } from '@office/db';
import { UiClientMessageSchema, type OfficeEvent, type UiServerMessage } from '@office/shared';
import type { EventHub } from '../services/event-hub.js';
import { listEvents } from '../services/event-store.js';

interface Sub {
  unsubscribe: () => void;
  lastSeq: number;
}

const PAGE = 1000;

export class UiGateway {
  constructor(
    private prisma: PrismaClient,
    private hub: EventHub,
    private log: FastifyBaseLogger,
  ) {}

  /** Authentication is done by the app-wide onRequest hook: an unauthenticated upgrade gets HTTP 401. */
  register(app: FastifyInstance) {
    app.get('/ws/ui', { websocket: true }, (socket) => this.accept(socket));
  }

  private accept(socket: WebSocket) {
    const subs = new Map<string, Sub>();
    let chain = Promise.resolve();
    const send = (msg: UiServerMessage) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
    };

    const subscribe = async (topic: string, afterSeq = 0) => {
      subs.get(topic)?.unsubscribe();
      subs.delete(topic);
      if (!topic.startsWith('run:')) {
        const sub: Sub = { lastSeq: 0, unsubscribe: this.hub.subscribe(topic, (m) => send({ ...(m as object), topic } as UiServerMessage)) };
        subs.set(topic, sub);
        return;
      }
      const session = await this.prisma.agentSession.findUnique({
        where: { runId: topic.slice(4) },
        select: { id: true },
      });
      if (!session) return send({ type: 'error', message: 'run not found' });

      // live messages are buffered until replay is done, then go through the same dedup as later ones
      let buffer: unknown[] | undefined = [];
      const sub: Sub = { lastSeq: afterSeq, unsubscribe: () => {} };
      const live = (m: unknown) => {
        if ((m as { type: string }).type === 'run.status.changed') {
          return send({ ...(m as object), topic } as UiServerMessage);
        }
        const event = m as OfficeEvent;
        if (event.seq <= sub.lastSeq) return;
        sub.lastSeq = event.seq;
        send({ type: 'event', topic, event });
      };
      sub.unsubscribe = this.hub.subscribe(topic, (m) => (buffer ? buffer.push(m) : live(m)));
      subs.set(topic, sub);

      for (;;) {
        const page = await listEvents(this.prisma, session.id, sub.lastSeq, PAGE);
        if (subs.get(topic) !== sub) return; // unsubscribed or replaced meanwhile
        for (const event of page) send({ type: 'event', topic, event });
        if (page.length > 0) sub.lastSeq = page[page.length - 1]!.seq;
        if (page.length < PAGE) break;
      }
      send({ type: 'replay.done', topic, lastSeq: sub.lastSeq });
      const pending = buffer;
      buffer = undefined;
      for (const m of pending) live(m);
    };

    const handle = async (raw: string) => {
      let json: unknown;
      try {
        json = JSON.parse(raw);
      } catch {
        json = undefined;
      }
      const parsed = UiClientMessageSchema.safeParse(json);
      if (!parsed.success) return send({ type: 'error', message: 'invalid message' });
      if (parsed.data.type === 'unsubscribe') {
        subs.get(parsed.data.topic)?.unsubscribe();
        subs.delete(parsed.data.topic);
        return;
      }
      await subscribe(parsed.data.topic, parsed.data.afterSeq);
    };

    socket.on('message', (data) => {
      chain = chain.then(() => handle(String(data))).catch((err) => this.log.error({ err }, 'ui message failed'));
    });
    socket.on('close', () => {
      for (const s of subs.values()) s.unsubscribe();
      subs.clear();
    });
  }
}
