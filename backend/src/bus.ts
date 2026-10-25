import { EventEmitter } from 'node:events';
import { createServer, type Server } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { appendFileSync, mkdirSync, existsSync, createReadStream, statSync } from 'node:fs';
import { dirname, join, normalize, extname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AgentName, Envelope, Topic, Topics } from '../../shared/mesh-types.ts';

export type Handler<T extends Topic> = (env: Envelope<T>) => void | Promise<void>;

const MIME: Record<string, string> = { '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json', '.txt': 'text/plain' };

/**
 * In-process typed pub/sub. Every message is mirrored to browser pages over WebSocket (/ws on the
 * same port), pages can publish back, everything is appended to a JSONL log, and campaign assets
 * are served from /assets/ on the same HTTP server.
 */
export class Bus {
  private ee = new EventEmitter();
  private http: Server | null = null;
  private wss: WebSocketServer | null = null;
  private history: Envelope[] = [];
  private logPath: string | null;
  readonly assetsDir: string | null;

  constructor(opts: { port?: number; logPath?: string | null; assetsDir?: string | null } = {}) {
    this.ee.setMaxListeners(200);
    this.logPath = opts.logPath ?? null;
    this.assetsDir = opts.assetsDir ?? null;
    if (this.logPath) mkdirSync(dirname(this.logPath), { recursive: true });
    if (this.assetsDir) mkdirSync(this.assetsDir, { recursive: true });
    if (opts.port) this.listen(opts.port);
  }

  private listen(port: number) {
    this.http = createServer((req, res) => {
      const url = req.url ?? '/';
      res.setHeader('access-control-allow-origin', '*');
      if (url === '/health') { res.end(JSON.stringify({ ok: true, history: this.history.length })); return; }
      if (url.startsWith('/assets/') && this.assetsDir) {
        const rel = normalize(decodeURIComponent(url.slice('/assets/'.length))).replace(/^(\.\.[/\\])+/, '');
        const file = join(this.assetsDir, rel);
        if (!file.startsWith(this.assetsDir) || !existsSync(file) || !statSync(file).isFile()) { res.statusCode = 404; res.end('not found'); return; }
        res.setHeader('content-type', MIME[extname(file)] ?? 'application/octet-stream');
        res.setHeader('cache-control', 'public, max-age=3600');
        createReadStream(file).pipe(res);
        return;
      }
      res.statusCode = 404; res.end('not found');
    });
    this.wss = new WebSocketServer({ server: this.http, path: '/ws' });
    this.wss.on('connection', (ws) => {
      ws.send(JSON.stringify({ type: 'history', items: this.history.slice(-300) }));
      ws.on('message', (raw) => {
        try {
          const m = JSON.parse(String(raw)) as { topic: Topic; from: AgentName; payload: unknown; traceId?: string };
          if (!m.topic || !m.from) return;
          this.publish(m.from, m.topic, m.payload as never, m.traceId);
        } catch (e) { console.warn('[bus] bad ws message', e); }
      });
    });
    this.http.listen(port, () => console.info(`[bus] http + ws on :${port} (/ws, /assets/, /health)`));
  }

  publish<T extends Topic>(from: AgentName, topic: T, payload: Topics[T], traceId?: string): Envelope<T> {
    const env: Envelope<T> = { id: randomUUID(), ts: Date.now(), topic, from, traceId: traceId ?? randomUUID().slice(0, 8), payload };
    this.history.push(env);
    if (this.history.length > 1500) this.history.shift();
    if (this.logPath) { try { appendFileSync(this.logPath, JSON.stringify(env) + '\n'); } catch { /* ignore */ } }
    const json = JSON.stringify({ type: 'event', item: env });
    if (this.wss) for (const c of this.wss.clients) if (c.readyState === WebSocket.OPEN) c.send(json);
    queueMicrotask(() => { this.ee.emit(topic, env); this.ee.emit('*', env); });
    return env;
  }

  on<T extends Topic>(topic: T, handler: Handler<T>): () => void {
    const h = (env: Envelope<T>) => { Promise.resolve(handler(env)).catch((e) => console.error(`[bus] handler for ${topic} failed`, e)); };
    this.ee.on(topic, h);
    return () => this.ee.off(topic, h);
  }

  onAny(handler: (env: Envelope) => void): () => void { this.ee.on('*', handler); return () => this.ee.off('*', handler); }

  waitFor<T extends Topic>(topic: T, pred: (env: Envelope<T>) => boolean = () => true, timeoutMs = 30000): Promise<Envelope<T>> {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { off(); reject(new Error(`timeout waiting for ${topic}`)); }, timeoutMs);
      const off = this.on(topic, (env) => { if (pred(env)) { clearTimeout(t); off(); resolve(env); } });
    });
  }

  close() { this.wss?.close(); this.http?.close(); }
}
