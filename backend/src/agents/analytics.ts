import { z } from 'zod/v4';
import type { Bus } from '../bus.ts';
import type { LLMRouter } from '../llm/router.ts';
import type { CampaignKind, DailyReport, MetricsSnapshot, Weather } from '../../../shared/mesh-types.ts';

interface FootfallSample { t: number; passersby: number; lookers: number; walkIns: number; sec: number; weather: Weather }
interface SaleSample { t: number; amount: number; code?: string; items: string[] }

const WINDOW = 300;      // 5 sim-minutes
const BASELINE = 1800;   // prior 30 sim-minutes
const REPORT_EVERY = 30; // sim-seconds

/**
 * Analytics sub-agent: rolling trend reports on sim time, plus the daily report for the owner.
 * Publishes analytics.report every 30 sim-seconds and analytics.daily on request or day change.
 */
export class AnalyticsAgent {
  private foot: FootfallSample[] = [];
  private sales: SaleSample[] = [];
  private lastReport = -Infinity;
  private lastSimTime = 0;
  private scenario = 'regular';
  private weather: Weather = 'clear';
  private lastTrend: MetricsSnapshot['trend'] = 'flat';
  private narrating = false;
  // day bookkeeping
  private dayStart = 0;
  private day = 0;
  private dayFoot: FootfallSample[] = [];
  private daySales: SaleSample[] = [];
  private campaigns = new Map<string, { kind: CampaignKind; headline: string; code: string; approved: boolean; redemptions: number; items: string[] }>();
  private wasteValue = 0;

  constructor(private bus: Bus, private llm: LLMRouter) {
    bus.on('sim.footfall', (e) => {
      const p = e.payload;
      if (p.simTime < this.lastSimTime - 1) this.reset();
      this.lastSimTime = p.simTime; this.scenario = p.scenario; this.weather = p.weather;
      const s = { t: p.simTime, passersby: p.passersby, lookers: p.lookers, walkIns: p.walkIns, sec: p.windowSec, weather: p.weather };
      this.foot.push(s); this.dayFoot.push(s);
      this.prune(p.simTime);
      if (p.simTime - this.lastReport >= REPORT_EVERY) { this.lastReport = p.simTime; void this.report(p.simTime); }
    });
    bus.on('pos.sale', (e) => {
      const s = { t: e.payload.simTime, amount: e.payload.amount, code: e.payload.promoCode, items: e.payload.items };
      this.sales.push(s); this.daySales.push(s);
      if (s.code) for (const c of this.campaigns.values()) if (c.code === s.code) c.redemptions++;
    });
    bus.on('campaign.draft', (e) => { const c = e.payload.campaign; this.campaigns.set(c.id, { kind: c.kind, headline: c.headline, code: c.code, approved: false, redemptions: 0, items: c.items }); });
    bus.on('campaign.approved', (e) => { const c = this.campaigns.get(e.payload.campaignId); if (c) c.approved = true; });
    bus.on('inventory.alert', (e) => { if (e.payload.kind === 'wasted') this.wasteValue += e.payload.items.reduce((a, i) => a + (i.value ?? 0), 0); });
    bus.on('inventory.state', (e) => { if (e.payload.day !== this.day) { void this.daily(this.lastSimTime, 'day change'); this.day = e.payload.day; this.dayStart = this.lastSimTime; this.dayFoot = []; this.daySales = []; this.campaigns.clear(); this.wasteValue = 0; } });
    bus.on('analytics.request', () => void this.daily(this.lastSimTime, 'requested'));
  }

  private reset() { this.foot = []; this.sales = []; this.dayFoot = []; this.daySales = []; this.lastReport = -Infinity; this.lastTrend = 'flat'; this.dayStart = 0; }
  private prune(now: number) { const cut = now - WINDOW - BASELINE - 60; this.foot = this.foot.filter((s) => s.t >= cut); this.sales = this.sales.filter((s) => s.t >= cut); }

  snapshot(now: number): MetricsSnapshot {
    const inWin = (t: number) => t > now - WINDOW && t <= now;
    const inBase = (t: number) => t > now - WINDOW - BASELINE && t <= now - WINDOW;
    const fw = this.foot.filter((s) => inWin(s.t)), fb = this.foot.filter((s) => inBase(s.t));
    const sw = this.sales.filter((s) => inWin(s.t)), sb = this.sales.filter((s) => inBase(s.t));
    const sum = <T>(a: T[], f: (x: T) => number) => a.reduce((acc, x) => acc + f(x), 0);
    const winSec = Math.min(WINDOW, Math.max(1, sum(fw, (s) => s.sec)));
    const baseSec = sum(fb, (s) => s.sec);
    const passersby = sum(fw, (s) => s.passersby), lookers = sum(fw, (s) => s.lookers), walkIns = sum(fw, (s) => s.walkIns);
    const footfallPerMin = passersby / (winSec / 60);
    const conversion = walkIns ? sw.length / walkIns : 0;
    let baseline = { footfallPerMin, sales: sw.length, conversion };
    let trend: MetricsSnapshot['trend'] = 'flat';
    if (baseSec >= 60) {
      const bPass = sum(fb, (s) => s.passersby), bWalk = sum(fb, (s) => s.walkIns);
      const scale = winSec / baseSec;
      baseline = { footfallPerMin: bPass / (baseSec / 60), sales: sb.length * scale, conversion: bWalk ? sb.length / bWalk : 0 };
      if (baseline.footfallPerMin > 0) { const r = footfallPerMin / baseline.footfallPerMin; trend = r >= 1.3 ? 'up' : r <= 0.7 ? 'down' : 'flat'; }
      else if (footfallPerMin > 5) trend = 'up';
    }
    return { simTime: now, weather: this.weather, footfallPerMin, lookRate: passersby ? lookers / passersby : 0, walkIns, sales: sw.length, revenue: sum(sw, (s) => s.amount), conversion, baseline, baselineSec: baseSec >= 60 ? baseSec : 0, trend };
  }

  private async report(now: number) {
    const m = this.snapshot(now);
    const schema = z.object({ narrative: z.string().max(240) });
    const template = () => ({ narrative: `Footfall ${m.footfallPerMin.toFixed(0)}/min (${m.trend} vs ${m.baseline.footfallPerMin.toFixed(0)} baseline), ${(m.lookRate * 100).toFixed(0)}% look rate, ${m.walkIns} walk-ins, ${m.sales} sales, conversion ${(m.conversion * 100).toFixed(0)}%, weather ${m.weather}.` });
    const useModel = m.trend !== this.lastTrend && !this.narrating;
    this.lastTrend = m.trend;
    if (useModel) this.narrating = true;
    const { value, provider } = useModel
      ? await this.llm.complete({
          agent: 'analytics', task: 'narrative', schema, example: { narrative: 'Traffic is well above the morning baseline but sales have not moved.' }, template, maxTokens: 200,
          system: 'You are the analytics agent for a small café on Market Street, SF. Write one plain sentence (max 30 words) describing the traffic and sales picture for the owner. No advice, no exclamation marks.',
          user: JSON.stringify({ scenario: this.scenario, metrics: m }),
        }).finally(() => { this.narrating = false; })
      : { value: template(), provider: 'template' as const };
    this.bus.publish('analytics', 'analytics.report', { ...m, narrative: value.narrative, provider });
  }

  private async daily(now: number, why: string) {
    const sum = <T>(a: T[], f: (x: T) => number) => a.reduce((acc, x) => acc + f(x), 0);
    const footfall = sum(this.dayFoot, (s) => s.passersby), lookers = sum(this.dayFoot, (s) => s.lookers), walkIns = sum(this.dayFoot, (s) => s.walkIns);
    const weatherMix: Record<Weather, number> = { clear: 0, rain: 0, overcast: 0, night: 0 };
    for (const s of this.dayFoot) weatherMix[s.weather] += s.sec;
    const campaigns = [...this.campaigns.entries()].map(([id, c]) => ({ id, kind: c.kind, headline: c.headline, redemptions: c.redemptions, approved: c.approved }));
    const bogoCodes = new Set([...this.campaigns.values()].filter((c) => c.kind === 'bogo').map((c) => c.code));
    const wasteAvoidedValue = sum(this.daySales.filter((s) => s.code && bogoCodes.has(s.code)), (s) => s.amount);
    const base: Omit<DailyReport, 'narrative' | 'provider'> = {
      day: this.day, periodSec: now - this.dayStart, footfall, lookRate: footfall ? lookers / footfall : 0, walkIns, sales: this.daySales.length,
      revenue: sum(this.daySales, (s) => s.amount), conversion: walkIns ? this.daySales.length / walkIns : 0, campaigns, wasteValue: this.wasteValue, wasteAvoidedValue, weatherMix,
    };
    const schema = z.object({ narrative: z.string().max(600) });
    const template = () => ({ narrative: `Day ${base.day} (${why}): ${footfall} passersby, ${(base.lookRate * 100).toFixed(0)}% looked, ${walkIns} walk-ins, ${base.sales} sales for $${base.revenue.toFixed(2)} (conversion ${(base.conversion * 100).toFixed(0)}%). ${campaigns.length} campaign${campaigns.length === 1 ? '' : 's'} (${campaigns.map((c) => `${c.headline}: ${c.redemptions} redemptions`).join('; ') || 'none'}). Waste $${base.wasteValue.toFixed(2)}, sales on expiring stock $${wasteAvoidedValue.toFixed(2)}.` });
    const { value, provider } = await this.llm.complete({
      agent: 'analytics', task: 'daily', schema, example: { narrative: 'A slow, rainy day: 210 passersby, 14 walk-ins, 9 sales for $112. The rainy-day special brought 4 of those sales. No stock was wasted.' }, template, maxTokens: 900,
      system: 'You are the analytics agent for a small café. Write the end-of-day report for the owner in three short sentences with concrete numbers: traffic and conversion, campaigns and their effect, inventory waste. Plain language, no emoji.',
      user: JSON.stringify(base),
    });
    this.bus.publish('analytics', 'analytics.daily', { ...base, narrative: value.narrative, provider });
  }
}
