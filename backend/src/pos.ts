import type { Bus } from './bus.ts';
import type { Promo } from '../../shared/mesh-types.ts';

const MENU: [string, number][] = [['flat white', 5.5], ['cortado', 4.75], ['avocado toast', 12], ['small plates', 14], ['glass of wine', 13], ['pastry', 4.25], ['soup', 9]];

/** Mock point of sale: turns sim purchases into priced sales, applies a live promo, accepts manual ring-ups. */
export class MockPOS {
  private livePromo: Promo | null = null;
  private seed = 7;
  private n = 0;
  totals = { count: 0, revenue: 0, promoCount: 0 };

  constructor(private bus: Bus) {
    bus.on('sim.purchased', (e) => this.ring(e.payload.simTime, 'sim'));
    bus.on('promo.live', (e) => { this.livePromo = e.payload.promo; });
    bus.on('promo.expired', () => { this.livePromo = null; });
    bus.on('display.clear', () => { this.livePromo = null; });
    bus.on('mesh.control', (e) => { if (e.payload.action === 'ring_up') this.ring(Date.now() / 1000, 'manual', e.payload.amount, e.payload.promoCode); });
  }

  private rnd() { this.seed = (this.seed * 1103515245 + 12345) & 0x7fffffff; return this.seed / 0x7fffffff; }

  ring(simTime: number, source: 'sim' | 'manual', amount?: number, promoCode?: string) {
    const items: string[] = [];
    let total = amount ?? 0;
    if (amount == null) {
      const k = 1 + Math.floor(this.rnd() * 3);
      for (let i = 0; i < k; i++) { const [name, price] = MENU[Math.floor(this.rnd() * MENU.length)]; items.push(name); total += price; }
    }
    // A live promo is redeemed by most customers who came in during it
    let code = promoCode;
    if (!code && this.livePromo && this.rnd() < 0.7) code = this.livePromo.code;
    if (code && this.livePromo && code === this.livePromo.code) total = total * (1 - this.livePromo.discountPct / 100);
    total = Math.round(total * 100) / 100;
    this.totals.count++; this.totals.revenue += total; if (code) this.totals.promoCount++;
    this.bus.publish('pos', 'pos.sale', { id: `sale-${++this.n}`, simTime, amount: total, items, promoCode: code, source });
  }
}
