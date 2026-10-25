import { CONFIG } from '../config';
import { Stats } from './metrics';

export type AlertKind = 'LOW_LOOK_RATE' | 'HIGH_DWELL_NO_ENTRY' | 'TRAFFIC_SURGE' | 'BROWSE_NO_BUY';
export interface Alert { kind: AlertKind; severity: 'warn' | 'info' | 'opportunity'; t: number; message: string; }

/**
 * Threshold rules over rolling stats. A rule fires on the rising edge (condition goes
 * false -> true) and re-arms once the condition clears; a cooldown guards against flapping.
 */
export class AlertEngine {
  private lastFired = new Map<AlertKind, number>();
  private active = new Set<AlertKind>();
  reset() { this.lastFired.clear(); this.active.clear(); }

  evaluate(s: Stats): Alert[] {
    const A = CONFIG.alerts;
    const out: Alert[] = [];
    const rule = (kind: AlertKind, cond: boolean, severity: Alert['severity'], message: () => string) => {
      if (!cond) { this.active.delete(kind); return; }
      if (this.active.has(kind)) return;
      this.active.add(kind);
      const last = this.lastFired.get(kind) ?? -Infinity;
      if (s.t - last < A.cooldownSec) return;
      this.lastFired.set(kind, s.t);
      out.push({ kind, severity, t: s.t, message: message() });
    };
    rule('LOW_LOOK_RATE', s.passersby >= A.minPassersby && s.lookRate < A.lowLookRate, 'warn',
      () => `Only ${(s.lookRate * 100).toFixed(0)}% of ${s.passersby} passersby looked at the storefront in the last minute.`);
    rule('HIGH_DWELL_NO_ENTRY', s.longLooks >= A.highDwellLooks && s.entries === 0, 'info',
      () => `${s.longLooks} people looked for ${A.longDwellSec}s+ but nobody came in. Interest is there; the door isn't converting.`);
    rule('BROWSE_NO_BUY', s.leftStore >= A.browseNoBuy && s.purchases === 0, 'info',
      () => `${s.leftStore} visitors browsed and left without buying. Check pricing, the menu board, or counter wait time.`);
    rule('TRAFFIC_SURGE', s.passersbyPerMin >= A.surgePerMin, 'opportunity',
      () => `Foot traffic surge: ${s.passersbyPerMin.toFixed(0)} passersby/min. Good moment for a sidewalk promo.`);
    return out;
  }
}
