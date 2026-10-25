import { z } from 'zod';
import type { Bus } from '../bus.ts';
import type { LLMRouter } from '../llm/router.ts';
import type { MetricsSnapshot } from '../../../shared/mesh-types.ts';

interface FootfallSample { t: number; passersby: number; lookers: number; walkIns: number; sec: number }
interface SaleSample { t: number; amount: number; promo: boolean }

const WINDOW = 300;      // 5 sim-minutes
const BASELINE = 1800;   // prior 30 sim-minutes
const REPORT_EVERY = 30; // sim-seconds

/** Tracks footfall and sales trends on simulation time and publishes periodic reports. */
export class SensingAgent {
  private foot: FootfallSample[] = [];
  private sales: SaleSample[] = [];
  private lastReport = -Infinity;
  private lastSimTime = 0;
  private scenario = 'regular';
  private lastTrend: MetricsSnapshot['trend'] = 'flat';
  private narrating = false;

  constructor(private bus: Bus, private llm: LLMRouter) {
    bus.on('sim.footfall', (e) => {
      const p = e.payload;
      if (p.simTime < this.lastSimTime - 1) this.reset();     // sim was reset
      this.lastSimTime = p.simTime; this.scenario = p.scenario;
      this.foot.push({ t: p.simTime, passersby: p.passersby, lookers: p.lookers, walkIns: p.walkIns, sec: p.windowSec });
      this.prune(p.simTime);
      if (p.simTime - this.lastReport >= REPORT_EVERY) { this.lastReport = p.simTime; void this.report(p.simTime); }
    });
    bus.on('pos.sale', (e) => { this.sales.push({ t: e.payload.simTime, amount: e.payload.amount, promo: !!e.payload.promoCode }); });
  }

  private reset() { this.foot = []; this.sales = []; this.lastReport = -Infinity; this.lastTrend = 'flat'; }
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
      const scale = winSec / baseSec;  // scale baseline counts to the current window length
      baseline = { footfallPerMin: bPass / (baseSec / 60), sales: sb.length * scale, conversion: bWalk ? sb.length / bWalk : 0 };
      if (baseline.footfallPerMin > 0) {
        const r = footfallPerMin / baseline.footfallPerMin;
        trend = r >= 1.3 ? 'up' : r <= 0.7 ? 'down' : 'flat';
      } else if (footfallPerMin > 5) trend = 'up';
    }
    return { simTime: now, footfallPerMin, lookRate: passersby ? lookers / passersby : 0, walkIns, sales: sw.length, revenue: sum(sw, (s) => s.amount), conversion, baseline, baselineSec: baseSec >= 60 ? baseSec : 0, trend };
  }

  private async report(now: number) {
    const m = this.snapshot(now);
    const schema = z.object({ narrative: z.string().max(240) });
    const template = () => ({ narrative: `Footfall ${m.footfallPerMin.toFixed(0)}/min (${m.trend} vs ${m.baseline.footfallPerMin.toFixed(0)} baseline), ${(m.lookRate * 100).toFixed(0)}% look rate, ${m.walkIns} walk-ins, ${m.sales} sales, conversion ${(m.conversion * 100).toFixed(0)}%.` });
    // Model prose only when the trend changes and no call is in flight; reports must stay timely.
    const useModel = m.trend !== this.lastTrend && !this.narrating;
    this.lastTrend = m.trend;
    if (useModel) this.narrating = true;
    const { value, provider } = useModel
      ? await this.llm.complete({
          agent: 'sensing', task: 'narrative', schema, example: { narrative: 'Footfall is up 40% vs baseline but sales are flat.' }, template,
          system: 'You are the sensing agent for a small café on Market Street, SF. Write one plain sentence (max 30 words) describing the traffic and sales picture for the owner. No advice, no exclamation marks.',
          user: JSON.stringify({ scenario: this.scenario, metrics: m }),
        }).finally(() => { this.narrating = false; })
      : { value: template(), provider: 'template' as const };
    this.bus.publish('sensing', 'sensing.report', { ...m, narrative: value.narrative, provider });
  }
}
