import type { Bus } from '../bus.ts';
import type { Provider } from '../../../shared/mesh-types.ts';
import type { LLMProvider, LLMRequest } from './provider.ts';
import { ClaudeProvider, isConnectionError } from './claude.ts';
import { OllamaProvider } from './ollama.ts';
import { TemplateProvider } from './template.ts';

export interface RouterStatus { provider: Provider; online: boolean; forcedOffline: boolean }

/**
 * Picks the brain for each call: Claude when online with credentials, else local Ollama, else templates.
 * Connectivity is probed cheaply and cached; connection errors mark us offline for a while.
 */
export class LLMRouter {
  forcedOffline = process.env.MESH_FORCE_OFFLINE === '1';
  private pinned: Provider | null = (process.env.MESH_PROVIDER as Provider | undefined) ?? null;
  private claude: ClaudeProvider | null = null;
  private ollama = new OllamaProvider();
  private template = new TemplateProvider();
  private onlineCache: { value: boolean; at: number } = { value: false, at: 0 };
  private ollamaCache: { value: boolean; at: number } = { value: false, at: 0 };
  private offlineUntil = 0;
  private lastStatus = '';
  onStatus: ((s: RouterStatus) => void) | null = null;

  constructor(private bus: Bus) {
    const hasCreds = !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
    if (hasCreds) { try { this.claude = new ClaudeProvider(); } catch { this.claude = null; } }
    else console.info('[router] no ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN: Claude disabled, using Ollama/template');
  }

  async isOnline(): Promise<boolean> {
    if (this.forcedOffline || Date.now() < this.offlineUntil) return false;
    if (Date.now() - this.onlineCache.at < 30_000) return this.onlineCache.value;
    let ok = false;
    try { await fetch('https://api.anthropic.com/v1/models', { method: 'HEAD', signal: AbortSignal.timeout(2000) }); ok = true; } catch { ok = false; }
    this.onlineCache = { value: ok, at: Date.now() };
    return ok;
  }

  /** Ollama is opt-in (OLLAMA_ENABLED=1 or MESH_PROVIDER=ollama); otherwise offline means templates. */
  private ollamaEnabled = process.env.OLLAMA_ENABLED === '1' || process.env.MESH_PROVIDER === 'ollama';

  private async ollamaUp(): Promise<boolean> {
    if (!this.ollamaEnabled) return false;
    if (Date.now() - this.ollamaCache.at < 30_000) return this.ollamaCache.value;
    const model = await this.ollama.resolve();
    const v = model !== null;
    if (v && !this.warmed) { this.warmed = true; console.info(`[router] ollama model: ${model} (warming)`); void this.ollama.warm(); }
    this.ollamaCache = { value: v, at: Date.now() };
    return v;
  }
  private warmed = false;
  get ollamaModel(): string | null { return this.ollama.model; }

  async pick(): Promise<LLMProvider> {
    if (this.pinned === 'template') return this.template;
    if (this.pinned === 'ollama') return (await this.ollamaUp()) ? this.ollama : this.template;
    if (this.claude && (await this.isOnline())) return this.claude;
    if (await this.ollamaUp()) return this.ollama;
    return this.template;
  }

  async status(): Promise<RouterStatus> {
    const p = await this.pick();
    const s = { provider: p.name, online: await this.isOnline(), forcedOffline: this.forcedOffline };
    const key = JSON.stringify(s);
    if (key !== this.lastStatus) { this.lastStatus = key; this.onStatus?.(s); }
    return s;
  }

  setForcedOffline(v: boolean) { this.forcedOffline = v; this.onlineCache.at = 0; void this.status(); }

  async complete<T>(req: LLMRequest<T>): Promise<{ value: T; provider: Provider }> {
    const chain: LLMProvider[] = [];
    const first = await this.pick();
    chain.push(first);
    if (first.name === 'claude') { if (await this.ollamaUp()) chain.push(this.ollama); chain.push(this.template); }
    else if (first.name === 'ollama') chain.push(this.template);
    for (const p of chain) {
      const t0 = Date.now();
      try {
        const value = await p.complete(req);
        this.bus.publish('router', 'llm.call', { agent: req.agent, task: req.task, provider: p.name, ms: Date.now() - t0, ok: true });
        return { value, provider: p.name };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        this.bus.publish('router', 'llm.call', { agent: req.agent, task: req.task, provider: p.name, ms: Date.now() - t0, ok: false, error: msg.slice(0, 160) });
        console.warn(`[router] ${p.name} failed for ${req.agent}/${req.task}: ${msg.slice(0, 160)}`);
        if (p.name === 'claude' && isConnectionError(e)) { this.offlineUntil = Date.now() + 30_000; void this.status(); }
      }
    }
    // unreachable: template never throws
    return { value: req.template(), provider: 'template' };
  }
}
