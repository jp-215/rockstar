import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import type { Bus } from '../bus.ts';
import type { LLMRouter } from '../llm/router.ts';
import type { OwnerChannel } from '../adapters/owner.ts';
import type { Campaign, CampaignBrief, CampaignKind, InventoryAlert, MetricsSnapshot } from '../../../shared/mesh-types.ts';

const COOLDOWN: Record<CampaignKind, number> = { flash: 600, winback: 900, bogo: 1200 };   // sim-seconds
const MIN_PASSERSBY = 20;
const MIN_BASELINE_SEC = 180;
const LOW_TRAFFIC_PER_MIN = 8;
const LIFT_AFTER = 300;
const pct = (x: number) => `${(x * 100).toFixed(0)}%`;

/**
 * Manager (supervisor). Reads analytics and inventory signals, decides, briefs the campaign agent,
 * and is the ONLY agent that talks to the store owner (Telegram). Owner approval gates every campaign.
 */
export class ManagerAgent {
  private latest: MetricsSnapshot | null = null;
  private lastTrigger: Record<CampaignKind, number> = { flash: -Infinity, winback: -Infinity, bogo: -Infinity };
  private pending: Campaign | null = null;
  private briefOut: CampaignBrief | null = null;
  private live: { campaign: Campaign; before: MetricsSnapshot; liveAt: number; redemptions: number; reported: boolean; reportedEmpty: boolean } | null = null;
  private bogoDone = new Set<string>();   // sku@day already campaigned

  constructor(private bus: Bus, private llm: LLMRouter, private owner: OwnerChannel) {
    bus.on('analytics.report', (e) => { this.latest = e.payload; void this.onReport(e.payload, e.traceId); });
    bus.on('inventory.alert', (e) => void this.onInventory(e.payload, e.traceId));
    bus.on('campaign.draft', (e) => void this.requestApproval(e.payload.campaign, e.traceId));
    bus.on('owner.action', (e) => this.decide(e.payload.campaignId, e.payload.action, e.payload.by, e.traceId));
    bus.on('owner.reply', (e) => void this.onOwnerText(e.payload.text, e.payload.by, e.traceId));
    bus.on('campaign.live', (e) => { if (this.latest) this.live = { campaign: e.payload.campaign, before: this.latest, liveAt: this.latest.simTime, redemptions: 0, reported: false, reportedEmpty: false }; });
    bus.on('campaign.expired', () => { this.live = null; });
    bus.on('pos.sale', (e) => { if (this.live && e.payload.promoCode === this.live.campaign.code) { this.live.redemptions++; if (this.latest) void this.maybeLift(this.latest, e.traceId); } });
    bus.on('comms.sent', (e) => void this.tell(`Customers notified: ${e.payload.count} opted-in customer${e.payload.count === 1 ? '' : 's'} got the campaign message.`, 'info', e.traceId));
    bus.on('security.injection_blocked', (e) => void this.tell(`Security: a customer message tried to steer the system (${e.payload.reason}). It was sandboxed and ignored. Excerpt: "${e.payload.excerpt}"`, 'alert', e.traceId));
    bus.on('analytics.daily', (e) => void this.tell(`Daily report, day ${e.payload.day}: ${e.payload.narrative}`, 'report', e.traceId));
  }

  /** The single door to the owner. */
  private async tell(text: string, kind: 'brief' | 'approval' | 'lift' | 'alert' | 'report' | 'info', traceId: string, campaignId?: string, imageUrl?: string | null) {
    this.bus.publish('manager', 'owner.message', { text, kind, campaignId, imageUrl }, traceId);
    await this.owner.send(text, imageUrl);
  }

  private canTrigger(kind: CampaignKind, now: number) { return !this.live && !this.pending && !this.briefOut && now - this.lastTrigger[kind] >= COOLDOWN[kind]; }

  private brief(kind: CampaignKind, trigger: string, items: string[], maxDiscountPct: number, durationMin: number, metrics: MetricsSnapshot | undefined, traceId: string) {
    const b: CampaignBrief = { id: `cmp-${Date.now().toString(36)}-${randomUUID().slice(0, 4)}`, kind, trigger, items, maxDiscountPct, durationMin, metrics };
    this.briefOut = b;
    if (metrics) this.lastTrigger[kind] = metrics.simTime; else if (this.latest) this.lastTrigger[kind] = this.latest.simTime; else this.lastTrigger[kind] = 0;
    this.bus.publish('manager', 'manager.decision', { kind: 'campaign', reason: trigger, briefId: b.id }, traceId);
    this.bus.publish('manager', 'campaign.brief', b, traceId);
  }

  // ---- trigger 1 + 2: traffic signals from analytics
  private async onReport(m: MetricsSnapshot, traceId: string) {
    if (this.live) { await this.maybeLift(m, traceId); return; }
    if (m.baselineSec < MIN_BASELINE_SEC) return;
    const passersby = m.footfallPerMin * 5;
    const salesFlat = m.sales <= Math.max(m.baseline.sales, 0) + 0.5;
    const conversionDown = m.baseline.conversion > 0 && m.conversion < 0.8 * m.baseline.conversion;
    if (m.trend === 'up' && passersby >= MIN_PASSERSBY && (salesFlat || conversionDown) && this.canTrigger('flash', m.simTime)) {
      const reason = conversionDown
        ? `Footfall up to ${m.footfallPerMin.toFixed(0)}/min (baseline ${m.baseline.footfallPerMin.toFixed(0)}) but conversion fell to ${pct(m.conversion)} from ${pct(m.baseline.conversion)}.`
        : `Footfall up to ${m.footfallPerMin.toFixed(0)}/min (baseline ${m.baseline.footfallPerMin.toFixed(0)}) while sales stayed flat at ${m.sales} in the last 5 min.`;
      await this.briefOwner(reason, m, 'flash', traceId);
      this.brief('flash', reason, [], 20, 30, m, traceId);
      return;
    }
    const badWeather = m.weather === 'rain' || m.weather === 'overcast';
    const lightTraffic = m.trend === 'down' || m.footfallPerMin < LOW_TRAFFIC_PER_MIN;
    if ((lightTraffic || (badWeather && m.footfallPerMin < m.baseline.footfallPerMin)) && this.canTrigger('winback', m.simTime)) {
      const reason = `${badWeather ? `Weather is ${m.weather} and f` : 'F'}ootfall is light at ${m.footfallPerMin.toFixed(0)}/min (baseline ${m.baseline.footfallPerMin.toFixed(0)}); the room is quiet.`;
      await this.briefOwner(reason, m, 'winback', traceId);
      this.brief('winback', reason, [], 15, 60, m, traceId);
    }
  }

  // ---- trigger 3 + 4: inventory signals
  private async onInventory(a: InventoryAlert, traceId: string) {
    if (a.kind === 'low') { await this.tell(`Stock alert: ${a.text} Reorder today.`, 'alert', traceId); return; }
    if (a.kind === 'wasted') { await this.tell(`Waste: ${a.text}`, 'alert', traceId); return; }
    // expiring within 4 days: sell it before it goes bad
    const items = a.items.filter((i) => !this.bogoDone.has(`${i.sku}@${i.daysLeft}`));
    if (!items.length) return;
    const now = this.latest?.simTime ?? 0;
    if (!this.canTrigger('bogo', now)) { await this.tell(`Heads up: ${a.text} I will propose a sell-through campaign once the current one ends.`, 'alert', traceId); return; }
    for (const i of items) this.bogoDone.add(`${i.sku}@${i.daysLeft}`);
    const reason = `${a.text} A buy-one-get-one moves it at margin instead of writing it off.`;
    await this.tell(`${reason} Asking the campaign agent for a draft; you will get it here for approval.`, 'brief', traceId);
    this.brief('bogo', reason, items.map((i) => i.name), 50, 120, this.latest ?? undefined, traceId);
  }

  private async briefOwner(reason: string, m: MetricsSnapshot, kind: CampaignKind, traceId: string) {
    const schema = z.object({ brief: z.string().max(400) });
    const { value } = await this.llm.complete({
      agent: 'manager', task: 'brief', schema, example: { brief: 'Traffic is up 45% in the last 5 minutes but sales are flat. I have asked the campaign agent to draft a flash promo for your approval.' },
      template: () => ({ brief: `${reason} I have asked the campaign agent to draft a ${kind === 'winback' ? 'win-back offer' : 'flash promo'} for your approval.` }), maxTokens: 200,
      system: 'You are the manager agent for a small café on Market Street, SF, briefing the owner on Telegram. Two or three short sentences, plain language, numbers included, no emoji. End by saying the campaign agent is drafting something for approval.',
      user: JSON.stringify({ reason, kind, metrics: m }),
    });
    await this.tell(value.brief, 'brief', traceId);
  }

  private async requestApproval(c: Campaign, traceId: string) {
    this.pending = c; this.briefOut = null;
    const text = `Approval needed (${c.kind}): "${c.headline}" — ${c.subline}. Offer ${c.offer}, code ${c.code}, ${c.durationMin} min${c.items.length ? `, items: ${c.items.join(', ')}` : ''}. ${c.rationale} Reply APPROVE to push it to the TV and customers, or REJECT.`;
    this.bus.publish('manager', 'campaign.approval_requested', { campaign: c, text }, traceId);
    await this.tell(text, 'approval', traceId, c.id, c.imageUrl ?? c.posterUrl);
  }

  private decide(campaignId: string, action: 'approve' | 'reject', by: string, traceId: string) {
    if (!this.pending || this.pending.id !== campaignId) return;
    const c = this.pending; this.pending = null;
    this.bus.publish('manager', 'owner.action', { campaignId, action, by }, traceId);
    if (action === 'approve') this.bus.publish('manager', 'campaign.approved', { campaignId, by }, traceId);
    else { this.bus.publish('manager', 'campaign.rejected', { campaignId, by }, traceId); void this.tell(`Understood, "${c.headline}" is dropped. Standing by.`, 'info', traceId); }
  }

  /** Free-text from the owner (real Telegram or the console). Only a few commands; everything else gets help. */
  private async onOwnerText(text: string, by: string, traceId: string) {
    const t = text.trim().toLowerCase();
    if (/^(approve|yes|ok|go|y)\b/.test(t)) { if (this.pending) this.decide(this.pending.id, 'approve', by, traceId); else await this.tell('Nothing is waiting for approval right now.', 'info', traceId); return; }
    if (/^(reject|no|n|stop)\b/.test(t)) { if (this.pending) this.decide(this.pending.id, 'reject', by, traceId); else await this.tell('Nothing is waiting for approval right now.', 'info', traceId); return; }
    if (/report|summary|how (are|did) we/.test(t)) { this.bus.publish('manager', 'analytics.request', { kind: 'daily', by }, traceId); return; }
    if (/status|what'?s (live|running)/.test(t)) { await this.tell(this.live ? `Live now: "${this.live.campaign.headline}" (code ${this.live.campaign.code}), ${this.live.redemptions} redemptions so far.` : this.pending ? `Waiting on your approval for "${this.pending.headline}".` : 'Nothing live. Watching traffic and inventory.', 'info', traceId); return; }
    await this.tell('Commands: APPROVE / REJECT the pending campaign, REPORT for today\'s numbers, STATUS for what is live.', 'info', traceId);
  }

  private async maybeLift(after: MetricsSnapshot, traceId: string) {
    const L = this.live;
    if (!L || L.reported) return;
    const elapsed = after.simTime - L.liveAt;
    const withSales = L.redemptions >= 1 && elapsed >= 30;
    if (!withSales && (elapsed < LIFT_AFTER || L.reportedEmpty)) return;
    if (withSales) L.reported = true; else L.reportedEmpty = true;
    const b = L.before;
    const schema = z.object({ text: z.string().max(400) });
    const template = () => ({ text: `Result for ${L.campaign.code} (${L.campaign.headline}): ${L.redemptions} redemption${L.redemptions === 1 ? '' : 's'} so far. Sales in the last 5 min ${after.sales} vs ${b.sales} before (${after.sales - b.sales >= 0 ? '+' : ''}${after.sales - b.sales}); conversion ${pct(after.conversion)} vs ${pct(b.conversion)}; footfall ${after.footfallPerMin.toFixed(0)}/min.` });
    const { value } = await this.llm.complete({
      agent: 'manager', task: 'lift', schema, example: { text: 'Flash promo result: 3 redemptions, sales up from 2 to 6 in five minutes, conversion 15% to 38%.' }, template, maxTokens: 200,
      system: 'You are the manager agent reporting a campaign result to the café owner on Telegram. Two sentences, concrete numbers, honest about small samples, no emoji.',
      user: JSON.stringify({ campaign: L.campaign.code, kind: L.campaign.kind, redemptions: L.redemptions, before: b, after }),
    });
    await this.tell(value.text, 'lift', traceId, L.campaign.id);
    this.bus.publish('manager', 'manager.lift_report', { before: b, after, redemptions: L.redemptions, text: value.text, campaignId: L.campaign.id }, traceId);
  }
}
