import type { Bus } from './bus.ts';
import type { Campaign } from '../../shared/mesh-types.ts';

/** Menu items with prices; the inventory agent maps these names to ingredients. */
export const MENU: [string, number][] = [['flat white', 5.5], ['cortado', 4.75], ['avocado toast', 12], ['small plates', 14], ['glass of wine', 13], ['pastry', 4.25], ['soup', 9], ['salmon plate', 16]];

/** Mock point of sale: prices sim purchases, applies a live campaign, accepts manual ring-ups. */
export class MockPOS {
  private live: Campaign | null = null;
  private seed = 7;
  private n = 0;
  totals = { count: 0, revenue: 0, promoCount: 0 };

  constructor(private bus: Bus) {
    bus.on('sim.purchased', (e) => this.ring(e.payload.simTime, 'sim'));
    bus.on('campaign.live', (e) => { this.live = e.payload.campaign; });
    bus.on('campaign.expired', () => { this.live = null; });
    bus.on('display.clear', () => { this.live = null; });
    bus.on('mesh.control', (e) => { if (e.payload.action === 'ring_up') this.ring(Date.now() / 1000, 'manual', e.payload.amount, e.payload.promoCode); });
  }

  private rnd() { this.seed = (this.seed * 1103515245 + 12345) & 0x7fffffff; return this.seed / 0x7fffffff; }

  ring(simTime: number, source: 'sim' | 'manual', amount?: number, promoCode?: string) {
    const items: string[] = [];
    let total = amount ?? 0;
    if (amount == null) {
      const k = 1 + Math.floor(this.rnd() * 3);
      // During a BOGO / win-back campaign, most buyers pick the promoted items.
      const promoted = this.live && this.live.items.length ? MENU.filter(([n]) => this.live!.items.some((it) => n.includes(it.toLowerCase().split(' ')[0]))) : [];
      for (let i = 0; i < k; i++) {
        const pool = promoted.length && this.rnd() < 0.7 ? promoted : MENU;
        const [name, price] = pool[Math.floor(this.rnd() * pool.length)];
        items.push(name); total += price;
      }
    }
    let code = promoCode;
    if (!code && this.live && this.rnd() < 0.7) code = this.live.code;
    if (code && this.live && code === this.live.code) total = total * (1 - this.live.discountPct / 100);
    total = Math.round(total * 100) / 100;
    this.totals.count++; this.totals.revenue += total; if (code) this.totals.promoCount++;
    this.bus.publish('pos', 'pos.sale', { id: `sale-${++this.n}`, simTime, amount: total, items, promoCode: code, source });
  }
}
