import type { UiClientMessage, UiServerMessage } from '@office/shared';

type Listener = (m: UiServerMessage) => void;

/** Highest event seq seen for a topic; non-event messages leave it unchanged. */
export function nextAfterSeq(afterSeq: number, message: UiServerMessage): number {
  return message.type === 'event' ? Math.max(afterSeq, message.event.seq) : afterSeq;
}

const MIN_DELAY = 1000;
const MAX_DELAY = 30_000;

export class UiSocket {
  private topics = new Map<string, { afterSeq: number; listeners: Set<Listener> }>();
  private ws: WebSocket | undefined;
  private delay = MIN_DELAY;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private url: string,
    private create: (url: string) => WebSocket = (u) => new WebSocket(u),
  ) {}

  subscribe(topic: string, afterSeq: number, onMessage: Listener): () => void {
    let t = this.topics.get(topic);
    if (!t) {
      t = { afterSeq, listeners: new Set() };
      this.topics.set(topic, t);
      this.send({ type: 'subscribe', topic, afterSeq });
    }
    t.listeners.add(onMessage);
    this.connect();
    return () => {
      const cur = this.topics.get(topic);
      if (!cur) return;
      cur.listeners.delete(onMessage);
      if (cur.listeners.size === 0) {
        this.topics.delete(topic);
        this.send({ type: 'unsubscribe', topic });
      }
    };
  }

  /** Sends when connected; terminal keystrokes are not queued, a dropped one is retyped. */
  send(m: UiClientMessage) {
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(m));
  }

  private connect() {
    if (this.ws || this.timer) return;
    const ws = this.create(this.url);
    this.ws = ws;
    ws.onopen = () => {
      this.delay = MIN_DELAY;
      for (const [topic, t] of this.topics) this.send({ type: 'subscribe', topic, afterSeq: t.afterSeq });
    };
    ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data)) as UiServerMessage;
      const targets = m.type === 'error' ? [...this.topics.values()] : [this.topics.get(m.topic)];
      for (const t of targets) {
        if (!t) continue;
        t.afterSeq = nextAfterSeq(t.afterSeq, m);
        for (const l of t.listeners) l(m);
      }
    };
    ws.onclose = () => {
      this.ws = undefined;
      if (this.topics.size === 0) return;
      this.timer = setTimeout(() => {
        this.timer = undefined;
        this.connect();
      }, this.delay);
      this.delay = Math.min(this.delay * 2, MAX_DELAY);
    };
  }
}

let shared: UiSocket | undefined;
/** One socket per browser tab. */
export function uiSocket(): UiSocket {
  const base = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';
  return (shared ??= new UiSocket(`${base.replace(/^http/, 'ws')}/ws/ui`));
}
