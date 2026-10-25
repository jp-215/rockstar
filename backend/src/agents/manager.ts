import { z } from 'zod';
import type { Bus } from '../bus.ts';
import type { LLMRouter } from '../llm/router.ts';
import type { SlackAdapter } from '../adapters/slack.ts';
import type { MetricsSnapshot, Promo } from '../../../shared/mesh-types.ts';

const COOLDOWN = 600;          // sim-seconds between opportunities
const MIN_PASSERSBY = 20;
const LIFT_AFTER = 300;        // sim-seconds after promo live before reporting even without a sale

const pct = (x: number) => `${(x * 100).toFixed(0)}%`;

/** Watches sensing reports, spots "traffic up but sales flat", runs approvals, reports the lift. */
export class ManagerAgent {
  private latest: MetricsSnapshot | null = null;
  private lastOpportunityAt = -Infinity;
  private pending: Promo | null = null;
  private live: { promo: Promo; before: MetricsSnapshot; liveAt: number; promoSales: number; reported: boolean; reportedEmpty: boolean } | null = null;

  constructor(private bus: Bus, private llm: LLMRouter, private slack: SlackAdapter) {
    bus.on('sensing.report', (e) => { this.latest = e.payload; void this.evaluate(e.payload, e.traceId); });
    bus.on('marketing.promo_draft', (e) => void this.requestApproval(e.payload.promo, e.traceId));
    bus.on('comms.slack.action', (e) => this.onAction(e.payload.promoId, e.payload.action, e.payload.by, e.traceId));
    bus.on('promo.live', (e) => { if (this.latest) this.live = { promo: e.payload.promo, before: this.latest, liveAt: this.latest.simTime, promoSales: 0, reported: false, reportedEmpty: false }; });
    bus.on('promo.expired', () => { this.live = null; });
    bus.on('pos.sale', (e) => { if (this.live && e.payload.promoCode === this.live.promo.code) { this.live.promoSales++; if (this.latest) void this.maybeLift(this.latest, e.traceId); } });
    bus.on('messaging.sent', (e) => void this.slack.post(`Telegram: promo sent to ${e.payload.count} opted-in customer${e.payload.count === 1 ? '' : 's'}.`, 'info'));
    bus.on('security.injection_blocked', (e) => void this.slack.post(`Security: a customer message on Telegram tried to steer the system (${e.payload.reason}). It was sandboxed and ignored. Excerpt: "${e.payload.excerpt}"`, 'security'));
  }

  private async evaluate(m: MetricsSnapshot, traceId: string) {
    if (this.live) { await this.maybeLift(m, traceId); return; }
    if (this.pending) return;
    if (m.simTime - this.lastOpportunityAt < COOLDOWN) return;
    const passersby = m.footfallPerMin * 5;
    const salesFlat = m.sales <= Math.max(m.baseline.sales, 0) + 0.5;
    const conversionDown = m.baseline.conversion > 0 && m.conversion < 0.8 * m.baseline.conversion;
    if (!(m.trend === 'up' && passersby >= MIN_PASSERSBY && (salesFlat || conversionDown))) return;

    this.lastOpportunityAt = m.simTime;
    const reason = conversionDown
      ? `Footfall up to ${m.footfallPerMin.toFixed(0)}/min (baseline ${m.baseline.footfallPerMin.toFixed(0)}) but conversion fell to ${pct(m.conversion)} from ${pct(m.baseline.conversion)}.`
      : `Footfall up to ${m.footfallPerMin.toFixed(0)}/min (baseline ${m.baseline.footfallPerMin.toFixed(0)}) while sales stayed flat at ${m.sales} in the last 5 min.`;
    const schema = z.object({ brief: z.string().max(400) });
    const { value } = await this.llm.complete({
      agent: 'manager', task: 'brief', schema,
      example: { brief: 'Traffic is up 45% in the last 5 minutes but sales are flat. I have asked marketing to draft a flash promo for your approval.' },
      template: () => ({ brief: `${reason} I have asked marketing to draft a flash promo for your approval.` }),
      system: 'You are the manager agent for a small café on Market Street, SF, briefing the owner in Slack. Two or three short sentences, plain language, numbers included, no emoji. End by saying marketing is drafting a promo for approval.',
      user: JSON.stringify({ reason, metrics: m }),
    });
    await this.slack.post(value.brief, 'brief');
    this.bus.publish('manager', 'manager.brief', { text: value.brief, kind: 'brief' }, traceId);
    this.bus.publish('manager', 'manager.opportunity', { reason, metrics: m }, traceId);
  }

  private async requestApproval(promo: Promo, traceId: string) {
    this.pending = promo;
    const text = `Approval needed: ${promo.headline} (${promo.discountPct}% off for ${promo.durationMin} min, code ${promo.code}). ${promo.rationale} Approve to push it to the TV and opted-in customers.`;
    await this.slack.requestApproval(promo, text);
    this.bus.publish('manager', 'promo.approval_requested', { promo, text }, traceId);
  }

  private onAction(promoId: string, action: 'approve' | 'reject', by: string, traceId: string) {
    if (!this.pending || this.pending.id !== promoId) return;
    this.pending = null;
    if (action === 'approve') this.bus.publish('manager', 'promo.approved', { promoId, by }, traceId);
    else { this.bus.publish('manager', 'promo.rejected', { promoId, by }, traceId); void this.slack.post(`Promo ${promoId} rejected by ${by}. Standing by.`, 'info'); }
  }

  private async maybeLift(after: MetricsSnapshot, traceId: string) {
    const L = this.live;
    if (!L || L.reported) return;
    const elapsed = after.simTime - L.liveAt;
    const withSales = L.promoSales >= 1 && elapsed >= 30;
    if (!withSales && (elapsed < LIFT_AFTER || L.reportedEmpty)) return;
    if (withSales) L.reported = true; else L.reportedEmpty = true;   // an empty interim report still allows a later one with sales
    const b = L.before;
    const deltaSales = after.sales - b.sales;
    const schema = z.object({ text: z.string().max(400) });
    const template = () => ({ text: `Lift report for ${L.promo.code}: ${L.promoSales} promo redemption${L.promoSales === 1 ? '' : 's'} so far. Sales in the last 5 min ${after.sales} vs ${b.sales} before (${deltaSales >= 0 ? '+' : ''}${deltaSales}); conversion ${pct(after.conversion)} vs ${pct(b.conversion)}; footfall ${after.footfallPerMin.toFixed(0)}/min.` });
    const { value } = await this.llm.complete({
      agent: 'manager', task: 'lift', schema, example: { text: 'Flash promo result: 3 redemptions, sales up from 2 to 6 in five minutes, conversion 15% to 38%.' }, template,
      system: 'You are the manager agent reporting a promo result to the café owner in Slack. Two sentences, concrete numbers, honest about small samples, no emoji.',
      user: JSON.stringify({ promo: L.promo.code, promoSales: L.promoSales, before: b, after }),
    });
    await this.slack.post(value.text, 'lift');
    this.bus.publish('manager', 'manager.lift_report', { before: b, after, promoSales: L.promoSales, text: value.text }, traceId);
  }
}
