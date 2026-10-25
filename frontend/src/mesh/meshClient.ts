import { WS_URL, type AgentName, type Envelope, type Topic, type Topics } from '../../../shared/mesh-types';

type Handler<T extends Topic> = (env: Envelope<T>) => void;

/** Browser-side client for the mesh bus: auto-reconnecting WebSocket with typed publish/subscribe. */
export class MeshClient {
  private ws: WebSocket | null = null;
  private handlers = new Map<string, Set<Handler<Topic>>>();
  private queue: string[] = [];
  private retry = 1000;
  connected = false;
  onConnection: ((connected: boolean) => void) | null = null;

  constructor(private from: AgentName, private url = WS_URL) { this.connect(); }

  private connect() {
    try { this.ws = new WebSocket(this.url); } catch { this.scheduleReconnect(); return; }
    this.ws.onopen = () => { this.connected = true; this.retry = 1000; this.onConnection?.(true); for (const m of this.queue.splice(0)) this.ws!.send(m); };
    this.ws.onclose = () => { this.connected = false; this.onConnection?.(false); this.scheduleReconnect(); };
    this.ws.onerror = () => { /* onclose follows */ };
    this.ws.onmessage = (ev) => {
      try {
        const m = JSON.parse(ev.data as string) as { type: 'history'; items: Envelope[] } | { type: 'event'; item: Envelope };
        if (m.type === 'history') for (const it of m.items) this.dispatch(it, true);
        else this.dispatch(m.item, false);
      } catch { /* ignore */ }
    };
  }

  private scheduleReconnect() { setTimeout(() => this.connect(), this.retry); this.retry = Math.min(10000, this.retry * 1.6); }

  private dispatch(env: Envelope, fromHistory: boolean) {
    (env as Envelope & { fromHistory?: boolean }).fromHistory = fromHistory;
    this.handlers.get(env.topic)?.forEach((h) => h(env));
    this.handlers.get('*')?.forEach((h) => h(env));
  }

  on<T extends Topic>(topic: T | '*', handler: Handler<T>): () => void {
    const set = this.handlers.get(topic) ?? new Set();
    set.add(handler as Handler<Topic>);
    this.handlers.set(topic, set);
    return () => set.delete(handler as Handler<Topic>);
  }

  publish<T extends Topic>(topic: T, payload: Topics[T], traceId?: string) {
    const msg = JSON.stringify({ topic, from: this.from, payload, traceId });
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(msg);
    else if (this.queue.length < 200) this.queue.push(msg);
  }
}

export const isHistory = (env: Envelope) => !!(env as Envelope & { fromHistory?: boolean }).fromHistory;
