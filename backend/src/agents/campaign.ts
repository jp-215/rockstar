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
    const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
    const names = b.menu.map((m) => cap(m.name));
    const list = names.slice(0, 2).join(' & ') + (names.length > 2 ? ' & more' : '');
    const priced = b.menu.slice(0, 2).map((m) => `${cap(m.name)} $${m.price.toFixed(2)}`).join(' · ');
    const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);
    switch (b.kind) {
      case 'bogo': return { headline: clip(`2-for-1 ${list}`, 40), subline: clip(`Buy one, get one free — today only`, 60), offer: 'BOGO', discountPct: 50, customerText: clip(`Today only at the café on Market St: buy one, get one free on ${list.toLowerCase()} (${priced}). Show this message at the counter.`, 220), color: 'gold' as const, rationale: `${list} use stock that expires within days; a BOGO sells it at margin instead of writing it off.`, imagePrompt: `Appetising close-up of ${names.join(' and ').toLowerCase()} on a rustic café counter, warm morning light, shallow depth of field, no text` };
      case 'winback': return { headline: clip(`Warm up: ${names[0] ?? 'soup'} + coffee`, 40), subline: clip(`${priced} — 15% off while it pours`, 60), offer: '15% off', discountPct: 15, customerText: clip(`Grey day on Market St? Come dry off: ${list.toLowerCase()} 15% off for the next hour (${priced}). Show this message at the counter.`, 220), color: 'teal' as const, rationale: 'Traffic is light and the weather is keeping people away; warm, low-cost items bring them in.', imagePrompt: `Steaming ${names[0]?.toLowerCase() ?? 'soup'} and a coffee on a café table by a rain-streaked window, soft warm light, no text` };
      default: return { headline: clip(`20% off ${list}`, 40), subline: clip(`${priced} — next 30 min`, 60), offer: '20% off', discountPct: 20, customerText: clip(`Flash deal at the café on Market St: 20% off ${list.toLowerCase()} for the next 30 minutes (${priced}). Show this message at the counter.`, 220), color: 'red' as const, rationale: `Traffic is up but people are walking past; a short, visible deal on ${list.toLowerCase()} converts browsers now.`, imagePrompt: `Appetising ${names.join(' and ').toLowerCase()} on a café counter with a lively Market Street window behind, golden hour, no text` };
    }
  }

  private async draft(b: CampaignBrief, traceId: string) {
    const template = () => this.templateFor(b);
    const { value, provider } = await this.llm.complete({
      agent: 'campaign', task: `draft_${b.kind}`, schema: Draft, example: template(), template, maxTokens: 500,
      system: `You are the campaign agent for a small café on Market Street, San Francisco. Draft ONE campaign of kind "${b.kind}" built around REAL menu items from the brief (use their exact names and prices; never invent items). Rules: discount at most ${b.maxDiscountPct}% (a buy-one-get-one is 50), headline under 40 characters and naming at least one of the items (it goes on the storefront TV), subline under 60 with a price, customerText under 220 characters, friendly, no emoji, no links. imagePrompt describes an appetising photo of those items for a portrait poster, with no text in the image. Pick a color from red, teal, gold, black.`,
      user: JSON.stringify({ trigger: b.trigger, why: b.why, menu: b.menu, metrics: b.metrics }),
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
