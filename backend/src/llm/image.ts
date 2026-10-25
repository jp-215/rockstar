import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Bus } from '../bus.ts';
import type { CampaignColor, ImageProviderName } from '../../../shared/mesh-types.ts';
import { OLLAMA_URL } from './ollama.ts';

export interface ImageRequest {
  campaignId: string;
  prompt: string;        // scene description for the image model
  headline: string;
  subline: string;
  offer: string;
  code: string;
  color: CampaignColor;
  items: string[];
}
export interface ImageResult { url: string; provider: ImageProviderName }

const PALETTE: Record<CampaignColor, { bg1: string; bg2: string; fg: string; accent: string }> = {
  red:   { bg1: '#e4553f', bg2: '#8e2419', fg: '#fff6ee', accent: '#ffd166' },
  teal:  { bg1: '#1aa3a8', bg2: '#0b4d52', fg: '#f2fbfb', accent: '#ffd166' },
  gold:  { bg1: '#f7cf5a', bg2: '#b8860b', fg: '#2b1d0e', accent: '#c0392b' },
  black: { bg1: '#2b2b2b', bg2: '#0a0a0a', fg: '#f5f5f5', accent: '#f2c14e' },
};
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

/** Deterministic 16:9 poster. Always available; this is the offline floor for the campaign agent. */
export function renderPosterSvg(req: ImageRequest): string {
  const p = PALETTE[req.color];
  const items = req.items.slice(0, 3).map(esc).join(' · ');
  const headSize = req.headline.length > 22 ? 84 : 112;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720">
  <defs><radialGradient id="g" cx="30%" cy="20%" r="90%"><stop offset="0" stop-color="${p.bg1}"/><stop offset="1" stop-color="${p.bg2}"/></radialGradient></defs>
  <rect width="1280" height="720" fill="url(#g)"/>
  <g font-family="Helvetica Neue, Helvetica, Arial, sans-serif" text-anchor="middle" fill="${p.fg}">
    <text x="640" y="150" font-size="28" letter-spacing="8" opacity="0.85">MARKET ST. CAFÉ · TODAY</text>
    <text x="640" y="330" font-size="${headSize}" font-weight="800">${esc(req.headline)}</text>
    <text x="640" y="400" font-size="40" opacity="0.95">${esc(req.subline)}</text>
    ${items ? `<text x="640" y="470" font-size="34" fill="${p.accent}">${items}</text>` : ''}
    <rect x="440" y="520" width="400" height="84" rx="14" fill="none" stroke="${p.fg}" stroke-width="5" stroke-dasharray="14 10"/>
    <text x="640" y="576" font-size="40" letter-spacing="6">CODE ${esc(req.code)}</text>
    <text x="640" y="670" font-size="26" opacity="0.8">Show this screen or your message at the counter</text>
  </g>
</svg>`;
}

/** Writes assets under <assetsDir>/<campaignId>/ and returns URLs relative to the bus HTTP server. */
export class ImageRouter {
  private ollamaEnabled = process.env.OLLAMA_IMAGE_ENABLED === '1';
  private model = process.env.OLLAMA_IMAGE_MODEL ?? 'flux2-klein:4b';
  private available: { value: boolean; at: number } = { value: false, at: 0 };

  constructor(private bus: Bus, private assetsDir: string | null) {}

  async providerName(): Promise<ImageProviderName> { return (await this.ollamaUp()) ? 'ollama-image' : 'svg-template'; }

  private async ollamaUp(): Promise<boolean> {
    if (!this.ollamaEnabled) return false;
    if (Date.now() - this.available.at < 60_000) return this.available.value;
    let ok = false;
    try {
      const r = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(1500) });
      const d = (await r.json()) as { models?: { name: string }[] };
      ok = !!d.models?.some((m) => m.name === this.model || m.name === `${this.model}:latest`);
    } catch { ok = false; }
    this.available = { value: ok, at: Date.now() };
    return ok;
  }

  private save(campaignId: string, file: string, data: string | Buffer): string {
    if (this.assetsDir) { const dir = join(this.assetsDir, campaignId); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, file), data); }
    return `/assets/${campaignId}/${file}`;
  }

  /** The SVG poster is always produced. */
  poster(req: ImageRequest): string { return this.save(req.campaignId, 'poster.svg', renderPosterSvg(req)); }

  /** A generated hero image when a local image model is available; null otherwise. */
  async generate(req: ImageRequest): Promise<ImageResult | null> {
    if (!(await this.ollamaUp())) return null;
    const t0 = Date.now();
    try {
      // Ollama's experimental image generation exposes an OpenAI-compatible endpoint.
      const r = await fetch(`${OLLAMA_URL}/v1/images/generations`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(Number(process.env.OLLAMA_IMAGE_TIMEOUT_MS ?? 180_000)),
        body: JSON.stringify({ model: this.model, prompt: req.prompt, n: 1, size: '1024x576', response_format: 'b64_json' }),
      });
      if (!r.ok) throw new Error(`image endpoint ${r.status}`);
      const d = (await r.json()) as { data?: { b64_json?: string }[] };
      const b64 = d.data?.[0]?.b64_json;
      if (!b64) throw new Error('no image data');
      const url = this.save(req.campaignId, 'image.png', Buffer.from(b64, 'base64'));
      this.bus.publish('router', 'llm.call', { agent: 'campaign', task: 'image', provider: 'ollama-image', ms: Date.now() - t0, ok: true });
      return { url, provider: 'ollama-image' };
    } catch (e) {
      this.bus.publish('router', 'llm.call', { agent: 'campaign', task: 'image', provider: 'ollama-image', ms: Date.now() - t0, ok: false, error: String(e).slice(0, 120) });
      return null;
    }
  }
}
