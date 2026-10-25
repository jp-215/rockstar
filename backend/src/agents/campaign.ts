import { z } from 'zod/v4';
import type { Bus } from '../bus.ts';
import type { LLMRouter } from '../llm/router.ts';
import type { ImageRouter } from '../llm/image.ts';
import type { Campaign, CampaignBrief } from '../../../shared/mesh-types.ts';

const Draft = z.object({
  headline: z.string().min(3).max(40),
  subline: z.string().min(3).max(60),
  offer: z.string().min(2).max(40),
  discountPct: z.number(),
  customerText: z.string().min(10).max(220),
  color: z.enum(['red', 'teal', 'gold', 'black']),
  rationale: z.string().max(200),
  imagePrompt: z.string().min(10).max(300),
});

/**
 * Campaign sub-agent: turns a Manager brief into copy (text model) + visuals (image model or SVG
 * poster), then runs the campaign on the display once approved. Policy clamps live in code.
 */
export class CampaignAgent {
  private drafts = new Map<string, Campaign>();
  private expiry: ReturnType<typeof setTimeout> | null = null;

  constructor(private bus: Bus, private llm: LLMRouter, private images: ImageRouter, private opts: { demoMinutes?: number } = {}) {
    bus.on('campaign.brief', (e) => void this.draft(e.payload, e.traceId));
    bus.on('campaign.approved', (e) => this.goLive(e.payload.campaignId, e.traceId));
    bus.on('campaign.rejected', (e) => { this.drafts.delete(e.payload.campaignId); });
  }

  private templateFor(b: CampaignBrief) {
    const items = b.items.slice(0, 2).join(', ') + (b.items.length > 2 ? ' & more' : '');
    const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);
    switch (b.kind) {
      case 'bogo': return { headline: 'Buy one, get one free', subline: clip(`${items || 'Fresh today'} — today only`, 60), offer: 'BOGO', discountPct: 50, customerText: `Today only at the café on Market St: buy one, get one free on ${items || 'fresh items'}. Show this message at the counter.`, color: 'gold' as const, rationale: `${items || 'Fresh stock'} expires soon; a BOGO sells it at margin instead of writing it off.`, imagePrompt: `Appetising close-up of ${items || 'fresh bakery items'} on a rustic café counter, warm morning light, shallow depth of field, no text` };
      case 'winback': return { headline: 'Rainy day warm-up', subline: 'Free coffee with any plate', offer: 'Free coffee with any plate', discountPct: 15, customerText: `Grey day on Market St? Come dry off: free coffee with any plate at the café for the next hour. Show this message at the counter.`, color: 'teal' as const, rationale: 'Traffic is light and the weather is keeping people away; a warm, low-cost offer brings them in.', imagePrompt: 'Cosy café window on a rainy San Francisco street, steaming coffee cup in the foreground, soft warm interior light, no text' };
      default: return { headline: '20% OFF next 30 min', subline: 'Show this message at the counter', offer: '20% off', discountPct: 20, customerText: 'Flash deal at the café on Market St: 20% off everything for the next 30 minutes. Show this message at the counter.', color: 'red' as const, rationale: 'Traffic is up but people are walking past; a short, visible discount converts browsers now.', imagePrompt: 'Lively San Francisco café storefront at golden hour with people walking by, inviting glow from the window, no text' };
    }
  }

  private async draft(b: CampaignBrief, traceId: string) {
    const template = () => this.templateFor(b);
    const { value, provider } = await this.llm.complete({
      agent: 'campaign', task: `draft_${b.kind}`, schema: Draft, example: template(), template, maxTokens: 500,
      system: `You are the campaign agent for a small café on Market Street, San Francisco. Draft ONE campaign of kind "${b.kind}". Rules: discount at most ${b.maxDiscountPct}% (a buy-one-get-one is 50), headline under 40 characters (TV and storefront banner), subline under 60, customerText under 220 characters, friendly, no emoji, no links. ${b.items.length ? `Feature these items: ${b.items.join(', ')}.` : ''} imagePrompt describes a photo for the poster with no text in it. Pick a color from red, teal, gold, black.`,
      user: JSON.stringify({ trigger: b.trigger, items: b.items, metrics: b.metrics }),
    });
    const discountPct = Math.min(b.maxDiscountPct, Math.max(5, Math.round(value.discountPct)));
    const code = b.kind === 'bogo' ? 'BOGO' : b.kind === 'winback' ? `WARM${discountPct}` : `FLASH${discountPct}`;
    const base = { id: b.id, kind: b.kind, headline: value.headline, subline: value.subline, offer: value.offer, discountPct, durationMin: b.durationMin, code, items: b.items, customerText: value.customerText.includes(code) ? value.customerText : `${value.customerText} Code ${code}.`, color: value.color, rationale: value.rationale, trigger: b.trigger };
    const imgReq = { campaignId: b.id, prompt: value.imagePrompt, headline: base.headline, subline: base.subline, offer: base.offer, code, color: base.color, items: b.items };
    const posterUrl = await this.images.poster(imgReq);
    const img = await this.images.generate(imgReq);
    const campaign: Campaign = { ...base, posterUrl, imageUrl: img?.url ?? null, imageProvider: img?.provider ?? 'svg-template' };
    this.drafts.set(campaign.id, campaign);
    this.bus.publish('campaign', 'campaign.draft', { campaign, provider }, traceId);
  }

  private goLive(id: string, traceId: string) {
    const c = this.drafts.get(id);
    if (!c) return;
    this.drafts.delete(id);
    const minutes = this.opts.demoMinutes ?? c.durationMin;
    const expiresAt = Date.now() + minutes * 60_000;
    this.bus.publish('campaign', 'display.set', { campaign: c, expiresAt }, traceId);
    this.bus.publish('campaign', 'campaign.live', { campaign: c, expiresAt }, traceId);
    if (this.expiry) clearTimeout(this.expiry);
    this.expiry = setTimeout(() => {
      this.bus.publish('campaign', 'display.clear', { campaignId: c.id }, traceId);
      this.bus.publish('campaign', 'campaign.expired', { campaignId: c.id }, traceId);
    }, expiresAt - Date.now());
  }
}
