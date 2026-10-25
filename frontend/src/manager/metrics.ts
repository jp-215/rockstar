import { CONFIG } from '../config';
import { AttentionEvent, EventBus } from './eventBus';

export interface Stats {
  t: number;
  passersby: number;       // left the zone (looked or not) or entered, within window
  passersbyPerMin: number;
  lookers: number;
  lookRate: number;        // 0..1
  avgDwellSec: number;     // mean gaze_end dwell
  longLooks: number;       // gaze_end over alerts.longDwellSec
  stops: number;
  entries: number;
  purchases: number;
  leftStore: number;
  avgInsideSec: number;
  heat: number[];          // gaze_start x-position buckets across the zone
}

/** Rolling-window aggregation of attention events. */
export class Metrics {
  private events: AttentionEvent[] = [];
  private zoneX: [number, number];
  constructor(bus: EventBus, zone: { xMin: number; xMax: number }) {
    this.zoneX = [zone.xMin, zone.xMax];
    bus.on((e) => this.events.push(e));
  }

  reset() { this.events.length = 0; }

  compute(t: number): Stats {
    const W = CONFIG.metrics.windowSec;
    const cutoff = t - W;
    while (this.events.length && this.events[0].t < cutoff) this.events.shift();
    const elapsed = Math.min(W, Math.max(1, t));
    const heat = new Array<number>(CONFIG.metrics.heatBuckets).fill(0);
    let passersby = 0, lookers = 0, entries = 0, stops = 0, longLooks = 0, dwellSum = 0, dwellN = 0, purchases = 0, leftStore = 0, insideSum = 0;
    for (const e of this.events) {
      switch (e.type) {
        case 'zone_exit': passersby++; if (e.looked) lookers++; break;
        case 'entered': passersby++; lookers++; entries++; break;
        case 'stop_and_look': stops++; break;
        case 'purchased': purchases++; break;
        case 'left_store': leftStore++; insideSum += e.insideSec; break;
        case 'gaze_end': dwellSum += e.dwellMs; dwellN++; if (e.dwellMs / 1000 >= CONFIG.alerts.longDwellSec) longLooks++; break;
        case 'gaze_start': {
          const f = (e.x - this.zoneX[0]) / (this.zoneX[1] - this.zoneX[0]);
          const b = Math.max(0, Math.min(heat.length - 1, Math.floor(f * heat.length)));
          heat[b]++; break;
        }
      }
    }
    return {
      t, passersby, passersbyPerMin: passersby * (60 / elapsed), lookers,
      lookRate: passersby ? lookers / passersby : 0,
      avgDwellSec: dwellN ? dwellSum / dwellN / 1000 : 0,
      longLooks, stops, entries, purchases, leftStore,
      avgInsideSec: leftStore ? insideSum / leftStore : 0, heat,
    };
  }
}
