import { EventEmitter } from 'node:events';
import { WebSocketServer, WebSocket } from 'ws';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AgentName, Envelope, Topic, Topics } from '../../shared/mesh-types.ts';

export type Handler<T extends Topic> = (env: Envelope<T>) => void | Promise<void>;

/**
 * In-process typed pub/sub. Every message is mirrored to connected browser pages over WebSocket,
 * pages can publish back over the same socket, and everything is appended to a JSONL log.
 */
export class Bus {
  private ee = new EventEmitter();
  private wss: WebSocketServer | null = null;
  private history: Envelope[] = [];
  private logPath: string | null;

  constructor(opts: { port?: number; logPath?: string | null } = {}) {
    this.ee.setMaxListeners(100);
    this.logPath = opts.logPath ?? null;
    if (this.logPath) mkdirSync(dirname(this.logPath), { recursive: true });
    if (opts.port) this.listen(opts.port);
  }

  private listen(port: number) {
    this.wss = new WebSocketServer({ port });
    this.wss.on('connection', (ws) => {
      ws.send(JSON.stringify({ type: 'history', items: this.history.slice(-200) }));
      ws.on('message', (raw) => {
        try {
          const m = JSON.parse(String(raw)) as { topic: Topic; from: AgentName; payload: unknown; traceId?: string };
          if (!m.topic || !m.from) return;
          this.publish(m.from, m.topic, m.payload as never, m.traceId);
        } catch (e) { console.warn('[bus] bad ws message', e); }
      });
    });
    console.info(`[bus] websocket mirror on :${port}`);
  }

  publish<T extends Topic>(from: AgentName, topic: T, payload: Topics[T], traceId?: string): Envelope<T> {
    const env: Envelope<T> = { id: randomUUID(), ts: Date.now(), topic, from, traceId: traceId ?? randomUUID().slice(0, 8), payload };
    this.history.push(env);
    if (this.history.length > 1000) this.history.shift();
    if (this.logPath) { try { appendFileSync(this.logPath, JSON.stringify(env) + '\n'); } catch { /* ignore */ } }
    const json = JSON.stringify({ type: 'event', item: env });
    if (this.wss) for (const c of this.wss.clients) if (c.readyState === WebSocket.OPEN) c.send(json);
    // deliver asynchronously so publishers never re-enter handlers mid-call
    queueMicrotask(() => { this.ee.emit(topic, env); this.ee.emit('*', env); });
    return env;
  }

  on<T extends Topic>(topic: T, handler: Handler<T>): () => void {
    const h = (env: Envelope<T>) => { Promise.resolve(handler(env)).catch((e) => console.error(`[bus] handler for ${topic} failed`, e)); };
    this.ee.on(topic, h);
    return () => this.ee.off(topic, h);
  }

  onAny(handler: (env: Envelope) => void): () => void { this.ee.on('*', handler); return () => this.ee.off('*', handler); }

  /** Resolve on the next message of a topic matching the predicate (used by tests and agents). */
  waitFor<T extends Topic>(topic: T, pred: (env: Envelope<T>) => boolean = () => true, timeoutMs = 30000): Promise<Envelope<T>> {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { off(); reject(new Error(`timeout waiting for ${topic}`)); }, timeoutMs);
      const off = this.on(topic, (env) => { if (pred(env)) { clearTimeout(t); off(); resolve(env); } });
    });
  }

  close() { this.wss?.close(); }
}
