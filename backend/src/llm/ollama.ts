import type { LLMProvider, LLMRequest } from './provider.ts';

export const OLLAMA_URL = process.env.OLLAMA_URL ?? 'http://localhost:11434';
/** Preference order: small models first so the demo stays responsive on laptops. OLLAMA_MODEL overrides. */
const PREFERRED = [process.env.OLLAMA_MODEL, 'llama3.2:1b', 'llama3.2:3b', 'qwen2.5:1.5b', 'qwen2.5:3b', 'phi3:mini', 'llama3.2', 'llama3.1', 'llama3'].filter(Boolean) as string[];
const TIMEOUT_MS = Number(process.env.OLLAMA_TIMEOUT_MS ?? 60_000);

/** Local model via Ollama in JSON mode, validated against the request schema with one retry. */
export class OllamaProvider implements LLMProvider {
  readonly name = 'ollama' as const;
  model: string | null = null;

  static async tags(): Promise<string[]> {
    try {
      const r = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(1500) });
      if (!r.ok) return [];
      const d = (await r.json()) as { models?: { name: string }[] };
      return (d.models ?? []).map((m) => m.name);
    } catch { return []; }
  }

  /** Picks the first preferred model that is installed; null when Ollama is down or has no models. */
  async resolve(): Promise<string | null> {
    const have = await OllamaProvider.tags();
    const strip = (n: string) => n.replace(/:latest$/, '');
    this.model = PREFERRED.find((p) => have.some((h) => strip(h) === strip(p))) ?? have[0] ?? null;
    return this.model;
  }

  /** Loads the model into memory so the first real call isn't a cold start. Fire and forget. */
  async warm(): Promise<void> {
    if (!this.model) return;
    try { await fetch(`${OLLAMA_URL}/api/generate`, { method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS), body: JSON.stringify({ model: this.model, prompt: 'ok', keep_alive: '30m', options: { num_predict: 1 } }) }); } catch { /* ignore */ }
  }

  async complete<T>(req: LLMRequest<T>): Promise<T> {
    if (!this.model) throw new Error('no ollama model available');
    const system = `${req.system}\n\nRespond with ONLY a JSON object, no prose, exactly in this shape (same keys and value types):\n${JSON.stringify(req.example, null, 2)}`;
    let user = req.user;
    let lastErr: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      const r = await fetch(`${OLLAMA_URL}/api/chat`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS),
        body: JSON.stringify({ model: this.model, stream: false, format: 'json', keep_alive: '30m', options: { temperature: 0.4, num_predict: req.maxTokens ?? 400 }, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
      });
      if (!r.ok) throw new Error(`ollama ${r.status}`);
      const data = (await r.json()) as { message?: { content?: string } };
      try {
        const parsed = JSON.parse(data.message?.content ?? '');
        return req.schema.parse(parsed);
      } catch (e) {
        lastErr = e;
        user = `${req.user}\n\nYour previous answer was invalid (${String(e).slice(0, 200)}). Return only valid JSON in the required shape.`;
      }
    }
    throw new Error(`ollama output failed validation: ${String(lastErr).slice(0, 200)}`);
  }
}
