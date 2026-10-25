import { mkdirSync, writeFileSync } from 'node:fs';
import sharp from 'sharp';
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

/** Deterministic portrait poster, 1080×1920 (the storefront TV). Always available: the offline floor. */
export const POSTER_W = 1080, POSTER_H = 1920;
export function renderPosterSvg(req: ImageRequest): string {
  const p = PALETTE[req.color];
  const items = req.items.slice(0, 3).map(esc);
  const headWords = req.headline.split(' ');
  // wrap the headline onto up to 3 lines of ~12 characters
  const lines: string[] = []; let cur = '';
  for (const w of headWords) { if ((cur + ' ' + w).trim().length > 13 && cur) { lines.push(cur); cur = w; } else cur = (cur + ' ' + w).trim(); }
  if (cur) lines.push(cur);
  const headSize = lines.some((l) => l.length > 11) ? 128 : 150;
  const headY = 620 - (lines.length - 1) * (headSize * 0.55);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${POSTER_W}" height="${POSTER_H}" viewBox="0 0 ${POSTER_W} ${POSTER_H}">
  <defs><radialGradient id="g" cx="30%" cy="15%" r="110%"><stop offset="0" stop-color="${p.bg1}"/><stop offset="1" stop-color="${p.bg2}"/></radialGradient></defs>
  <rect width="${POSTER_W}" height="${POSTER_H}" fill="url(#g)"/>
  <g font-family="Helvetica Neue, Helvetica, Arial, sans-serif" text-anchor="middle" fill="${p.fg}">
    <text x="540" y="260" font-size="34" letter-spacing="10" opacity="0.85">MARKET ST. CAFÉ · TODAY</text>
    ${lines.map((l, i) => `<text x="540" y="${headY + i * headSize * 1.1}" font-size="${headSize}" font-weight="800">${esc(l)}</text>`).join('')}
    <text x="540" y="${headY + lines.length * headSize * 1.1 + 40}" font-size="52" opacity="0.95">${esc(req.subline)}</text>
    ${items.map((it, i) => `<text x="540" y="${1150 + i * 70}" font-size="54" fill="${p.accent}">${it}</text>`).join('')}
    <rect x="290" y="1440" width="500" height="110" rx="18" fill="none" stroke="${p.fg}" stroke-width="6" stroke-dasharray="18 12"/>
    <text x="540" y="1515" font-size="54" letter-spacing="8">CODE ${esc(req.code)}</text>
    <text x="540" y="1720" font-size="34" opacity="0.8">Show this screen or your message at the counter</text>
  </g>
</svg>`;
}

/** Rasterizes any image buffer or SVG to a 1080×1920 JPEG (cover-fit). */
export async function toPortraitJpeg(input: Buffer): Promise<Buffer> {
  return sharp(input).resize(POSTER_W, POSTER_H, { fit: 'cover', position: 'centre' }).jpeg({ quality: 88 }).toBuffer();
}

/**
 * Hosted FLUX via the Black Forest Labs API (FLUX_API_KEY). Submit → poll → download.
 * BFL caps dimensions at 1440 and needs multiples of 32, so we render 832×1440 (9:16) and upscale.
 */
class BflFluxProvider {
  private key = process.env.FLUX_API_KEY ?? '';
  private base = process.env.FLUX_API_BASE ?? 'https://api.bfl.ai';
  private model = process.env.FLUX_MODEL ?? 'flux-dev';
  get enabled() { return this.key.length > 0; }

  async generate(prompt: string, signal: AbortSignal): Promise<Buffer> {
    const headers = { 'x-key': this.key, 'content-type': 'application/json', accept: 'application/json' };
    const submit = await fetch(`${this.base}/v1/${this.model}`, { method: 'POST', headers, signal, body: JSON.stringify({ prompt, width: 832, height: 1440, safety_tolerance: 2, output_format: 'jpeg' }) });
    if (!submit.ok) throw new Error(`bfl submit ${submit.status}: ${(await submit.text()).slice(0, 160)}`);
    const job = (await submit.json()) as { id: string; polling_url?: string };
    const pollUrl = job.polling_url ?? `${this.base}/v1/get_result?id=${job.id}`;
    for (let i = 0; i < 120; i++) {
      await new Promise((r) => setTimeout(r, 1500));
      const r = await fetch(pollUrl.includes('?') ? pollUrl : `${pollUrl}?id=${job.id}`, { headers: { 'x-key': this.key, accept: 'application/json' }, signal });
      if (!r.ok) throw new Error(`bfl poll ${r.status}`);
      const d = (await r.json()) as { status: string; result?: { sample?: string } };
      if (d.status === 'Ready' && d.result?.sample) {
        const img = await fetch(d.result.sample, { signal });
        if (!img.ok) throw new Error(`bfl download ${img.status}`);
        return Buffer.from(await img.arrayBuffer());
      }
      if (d.status === 'Error' || d.status === 'Content Moderated' || d.status === 'Request Moderated') throw new Error(`bfl ${d.status}`);
    }
    throw new Error('bfl timeout');
  }
}

/** Writes assets under <assetsDir>/<campaignId>/ and returns URLs relative to the bus HTTP server. */
export class ImageRouter {
  private ollamaEnabled = process.env.OLLAMA_IMAGE_ENABLED === '1';
  private model = process.env.OLLAMA_IMAGE_MODEL ?? 'flux2-klein:4b';
  private available: { value: boolean; at: number } = { value: false, at: 0 };
  private bfl = new BflFluxProvider();
  forcedOffline = false;

  constructor(private bus: Bus, private assetsDir: string | null) {}

  async providerName(): Promise<ImageProviderName> {
    if (this.bfl.enabled && !this.forcedOffline) return 'bfl-flux';
    return (await this.ollamaUp()) ? 'ollama-image' : 'svg-template';
  }

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

  /** The poster is always produced: SVG source plus a 1080×1920 JPEG for the storefront TV. Returns the JPEG URL. */
  async poster(req: ImageRequest): Promise<string> {
    const svg = renderPosterSvg(req);
    this.save(req.campaignId, 'poster.svg', svg);
    try { return this.save(req.campaignId, 'poster.jpg', await toPortraitJpeg(Buffer.from(svg))); }
    catch (e) { console.warn('[image] jpeg render failed, serving svg', e); return this.save(req.campaignId, 'poster.svg', svg); }
  }

  /** A generated hero image: hosted FLUX when a key is present and we are online, else a local image model, else null. */
  async generate(req: ImageRequest): Promise<ImageResult | null> {
    if (this.bfl.enabled && !this.forcedOffline) {
      const t0 = Date.now();
      try {
        const raw = await this.bfl.generate(req.prompt, AbortSignal.timeout(Number(process.env.FLUX_TIMEOUT_MS ?? 180_000)));
        const url = this.save(req.campaignId, 'image.jpg', await toPortraitJpeg(raw));
        this.bus.publish('router', 'llm.call', { agent: 'campaign', task: 'image', provider: 'bfl-flux', ms: Date.now() - t0, ok: true });
        return { url, provider: 'bfl-flux' };
      } catch (e) {
        this.bus.publish('router', 'llm.call', { agent: 'campaign', task: 'image', provider: 'bfl-flux', ms: Date.now() - t0, ok: false, error: String(e).slice(0, 120) });
        console.warn('[image] bfl failed, trying local/template:', String(e).slice(0, 160));
      }
    }
    if (!(await this.ollamaUp())) return null;
    const t0 = Date.now();
    try {
      // Ollama's experimental image generation exposes an OpenAI-compatible endpoint.
      const r = await fetch(`${OLLAMA_URL}/v1/images/generations`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(Number(process.env.OLLAMA_IMAGE_TIMEOUT_MS ?? 180_000)),
        body: JSON.stringify({ model: this.model, prompt: req.prompt, n: 1, size: `${POSTER_W}x${POSTER_H}`, response_format: 'b64_json' }),
      });
      if (!r.ok) throw new Error(`image endpoint ${r.status}`);
      const d = (await r.json()) as { data?: { b64_json?: string }[] };
      const b64 = d.data?.[0]?.b64_json;
      if (!b64) throw new Error('no image data');
      const url = this.save(req.campaignId, 'image.jpg', await toPortraitJpeg(Buffer.from(b64, 'base64')));
      this.bus.publish('router', 'llm.call', { agent: 'campaign', task: 'image', provider: 'ollama-image', ms: Date.now() - t0, ok: true });
      return { url, provider: 'ollama-image' };
    } catch (e) {
      this.bus.publish('router', 'llm.call', { agent: 'campaign', task: 'image', provider: 'ollama-image', ms: Date.now() - t0, ok: false, error: String(e).slice(0, 120) });
      return null;
    }
  }
}
