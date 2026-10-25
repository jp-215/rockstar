import { z } from 'zod';
import type { Bus } from '../bus.ts';
import type { LLMRouter } from '../llm/router.ts';
import type { Promo } from '../../../shared/mesh-types.ts';

const MAX_DISCOUNT = 20;
const PromoDraft = z.object({
  headline: z.string().min(3).max(40),
  subline: z.string().min(3).max(60),
  discountPct: z.number(),
  durationMin: z.number(),
  telegramText: z.string().min(10).max(220),
  color: z.enum(['red', 'teal', 'gold', 'black']),
  rationale: z.string().max(200),
});

/** Drafts promos (policy-clamped), drives the TV display and storefront surfaces once approved. */
export class MarketingAgent {
  private drafts = new Map<string, Promo>();
  private expiry: ReturnType<typeof setTimeout> | null = null;
  private n = 0;

  constructor(private bus: Bus, private llm: LLMRouter, private opts: { demoMinutes?: number } = {}) {
    bus.on('manager.opportunity', (e) => void this.draft(e.payload.reason, e.payload.metrics, e.traceId));
    bus.on('promo.approved', (e) => this.goLive(e.payload.promoId, e.traceId));
    bus.on('promo.rejected', (e) => { this.drafts.delete(e.payload.promoId); });
  }

  private async draft(reason: string, metrics: unknown, traceId: string) {
    const template = () => ({
      headline: '20% OFF next 30 min', subline: 'Show this message at the counter', discountPct: 20, durationMin: 30,
      telegramText: 'Flash deal at the café on Market St: 20% off everything for the next 30 minutes. Show this message at the counter. Code FLASH20.',
      color: 'red' as const, rationale: 'Traffic is up but people are walking past; a short, visible discount converts browsers now.',
    });
    const { value, provider } = await this.llm.complete({
      agent: 'marketing', task: 'promo_draft', schema: PromoDraft, example: template(), template,
      system: `You are the marketing agent for a small café on Market Street, San Francisco. Draft ONE flash promo to convert passing foot traffic right now. Policy: discount at most ${MAX_DISCOUNT}%, duration 15 to 60 minutes, headline under 40 characters (goes on a TV and the storefront banner), telegramText under 220 characters and friendly, no emoji, no links. Pick a color from red, teal, gold, black.`,
      user: JSON.stringify({ reason, metrics }),
    });
    const id = `promo-${Date.now().toString(36)}-${++this.n}`;
    const discountPct = Math.min(MAX_DISCOUNT, Math.max(5, Math.round(value.discountPct)));
    const durationMin = Math.min(60, Math.max(15, Math.round(value.durationMin)));
    const promo: Promo = { id, ...value, discountPct, durationMin, code: `FLASH${discountPct}` };
    if (!promo.telegramText.includes(promo.code)) promo.telegramText = `${promo.telegramText} Code ${promo.code}.`;
    this.drafts.set(id, promo);
    this.bus.publish('marketing', 'marketing.promo_draft', { promo, provider }, traceId);
  }

  private goLive(promoId: string, traceId: string) {
    const promo = this.drafts.get(promoId);
    if (!promo) return;
    this.drafts.delete(promoId);
    const minutes = this.opts.demoMinutes ?? promo.durationMin;
    const expiresAt = Date.now() + minutes * 60_000;
    this.bus.publish('marketing', 'display.set', { promo, expiresAt }, traceId);
    this.bus.publish('marketing', 'promo.live', { promo, expiresAt }, traceId);
    if (this.expiry) clearTimeout(this.expiry);
    this.expiry = setTimeout(() => {
      this.bus.publish('marketing', 'display.clear', { promoId: promo.id }, traceId);
      this.bus.publish('marketing', 'promo.expired', { promoId: promo.id }, traceId);
    }, expiresAt - Date.now());
  }
}
