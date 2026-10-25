import type { Bus } from '../bus.ts';
import type { InventoryItem, InventoryState } from '../../../shared/mesh-types.ts';

export const DAY_LENGTH_SEC = Number(process.env.MESH_DAY_SEC ?? 600);   // sim-seconds per store day
const EXPIRING_DAYS = 4;

const SEED: InventoryItem[] = [
  // Expiry days are store-day indexes; nothing is within the 4-day window on day 0, so the first
  // sell-through campaign appears on day 2 (croissants, salmon, sourdough).
  { sku: 'croissant', name: 'Croissants', qty: 40, unit: 'pc', parLevel: 10, expiresDay: 6, cost: 1.2 },
  { sku: 'bread', name: 'Sourdough', qty: 15, unit: 'loaf', parLevel: 5, expiresDay: 6, cost: 3.5 },
  { sku: 'salmon', name: 'Smoked salmon', qty: 12, unit: 'portion', parLevel: 4, expiresDay: 6, cost: 4.0 },
  { sku: 'avocado', name: 'Avocados', qty: 30, unit: 'pc', parLevel: 8, expiresDay: 8, cost: 0.9 },
  { sku: 'soup', name: 'Soup of the day', qty: 20, unit: 'bowl', parLevel: 5, expiresDay: 8, cost: 2.0 },
  { sku: 'plates', name: 'Small plates prep', qty: 30, unit: 'plate', parLevel: 8, expiresDay: 8, cost: 4.5 },
  { sku: 'milk', name: 'Oat & dairy milk', qty: 20, unit: 'L', parLevel: 6, expiresDay: 10, cost: 1.8 },
  { sku: 'beans', name: 'Coffee beans', qty: 8, unit: 'kg', parLevel: 3, expiresDay: null, cost: 22 },
  { sku: 'wine', name: 'House wine', qty: 24, unit: 'glass', parLevel: 6, expiresDay: null, cost: 4.0 },
];

/** Which inventory a menu item consumes. */
export const RECIPES: Record<string, { sku: string; qty: number }[]> = {
  'flat white': [{ sku: 'beans', qty: 0.02 }, { sku: 'milk', qty: 0.2 }],
  'cortado': [{ sku: 'beans', qty: 0.02 }, { sku: 'milk', qty: 0.1 }],
  'avocado toast': [{ sku: 'avocado', qty: 1 }, { sku: 'bread', qty: 0.25 }],
  'small plates': [{ sku: 'plates', qty: 1 }],
  'glass of wine': [{ sku: 'wine', qty: 1 }],
  'pastry': [{ sku: 'croissant', qty: 1 }],
  'soup': [{ sku: 'soup', qty: 1 }, { sku: 'bread', qty: 0.1 }],
  'salmon plate': [{ sku: 'salmon', qty: 1 }, { sku: 'bread', qty: 0.2 }],
};

/** Menu items that use a given ingredient (for sell-through campaigns). */
export function menuItemsUsing(sku: string): string[] {
  return Object.entries(RECIPES).filter(([, parts]) => parts.some((r) => r.sku === sku && r.qty >= 0.2)).map(([name]) => name);
}

/**
 * Inventory sub-agent: stock levels, expiry dates on a store-day clock, consumption from POS sales.
 * Raises alerts (expiring within 4 days, below par, wasted at expiry) for the Manager to act on.
 */
export class InventoryAgent {
  private items: InventoryItem[] = SEED.map((i) => ({ ...i }));
  private day = 0;
  private wasteToday: InventoryState['wasteToday'] = [];
  private alertedExpiring = new Set<string>();  // `${sku}@${day}`
  private alertedLow = new Set<string>();
  private lastSimTime = 0;

  constructor(private bus: Bus) {
    bus.on('sim.footfall', (e) => {
      const t = e.payload.simTime;
      if (t < this.lastSimTime - 1) this.setDay(0);           // sim was reset
      this.lastSimTime = t;
      const d = Math.floor(t / DAY_LENGTH_SEC);
      if (d > this.day) this.setDay(d);                       // the clock only moves forward (console can advance it too)
    });
    bus.on('pos.sale', (e) => { for (const name of e.payload.items) for (const r of RECIPES[name] ?? []) this.adjust(r.sku, -r.qty, false); this.checkLow(); this.publish(); });
    bus.on('inventory.control', (e) => {
      const p = e.payload;
      if (p.action === 'adjust') { this.adjust(p.sku, p.delta, false); }
      else if (p.action === 'set_expiry') { const it = this.find(p.sku); if (it) it.expiresDay = p.expiresDay; }
      else if (p.action === 'advance_day') { this.setDay(this.day + 1); return; }
      else if (p.action === 'restock') { const it = this.find(p.sku); if (it) { it.qty = Math.max(it.qty, it.parLevel * 4); this.alertedLow.delete(p.sku); } }
      this.checkLow(); this.checkExpiring(); this.publish();
    });
    this.checkExpiring();
    this.publish();
  }

  private find(sku: string) { return this.items.find((i) => i.sku === sku); }
  private adjust(sku: string, delta: number, publish = true) { const it = this.find(sku); if (!it) return; it.qty = Math.max(0, Math.round((it.qty + delta) * 100) / 100); if (publish) this.publish(); }

  private setDay(d: number) {
    if (d <= this.day && d === 0) { this.items = SEED.map((i) => ({ ...i })); this.alertedExpiring.clear(); this.alertedLow.clear(); }   // sim reset
    this.day = d;
    this.wasteToday = [];
    // anything past its expiry day is thrown out
    const wasted = this.items.filter((i) => i.expiresDay !== null && i.expiresDay < d && i.qty > 0);
    if (wasted.length) {
      this.wasteToday = wasted.map((i) => ({ sku: i.sku, qty: i.qty, value: Math.round(i.qty * i.cost * 100) / 100 }));
      this.bus.publish('inventory', 'inventory.alert', { kind: 'wasted', items: wasted.map((i) => ({ sku: i.sku, name: i.name, qty: i.qty, value: Math.round(i.qty * i.cost * 100) / 100 })), text: `Thrown out at start of day ${d}: ${wasted.map((i) => `${i.qty} ${i.unit} ${i.name}`).join(', ')} ($${this.wasteToday.reduce((a, w) => a + w.value, 0).toFixed(2)}).` });
      for (const i of wasted) i.qty = 0;
    }
    this.checkExpiring(); this.checkLow(); this.publish();
  }

  private checkExpiring() {
    const soon = this.items.filter((i) => i.expiresDay !== null && i.qty > i.parLevel && i.expiresDay - this.day <= EXPIRING_DAYS && i.expiresDay >= this.day && !this.alertedExpiring.has(`${i.sku}@${this.day}`));
    if (!soon.length) return;
    for (const i of soon) this.alertedExpiring.add(`${i.sku}@${this.day}`);
    const items = soon.map((i) => ({ sku: i.sku, name: i.name, qty: i.qty, daysLeft: i.expiresDay! - this.day, value: Math.round(i.qty * i.cost * 100) / 100 }));
    this.bus.publish('inventory', 'inventory.alert', { kind: 'expiring', items, text: `Expiring within ${EXPIRING_DAYS} days: ${items.map((i) => `${i.qty} ${i.name} (${i.daysLeft}d)`).join(', ')}. Worth $${items.reduce((a, i) => a + (i.value ?? 0), 0).toFixed(2)} if sold.` });
  }

  private checkLow() {
    const low = this.items.filter((i) => i.qty <= i.parLevel && !this.alertedLow.has(i.sku));
    if (!low.length) return;
    for (const i of low) this.alertedLow.add(i.sku);
    this.bus.publish('inventory', 'inventory.alert', { kind: 'low', items: low.map((i) => ({ sku: i.sku, name: i.name, qty: i.qty, parLevel: i.parLevel })), text: `Running low: ${low.map((i) => `${i.name} ${i.qty}/${i.parLevel} ${i.unit}`).join(', ')}.` });
  }

  private publish() { this.bus.publish('inventory', 'inventory.state', { day: this.day, dayLengthSec: DAY_LENGTH_SEC, items: this.items.map((i) => ({ ...i })), wasteToday: this.wasteToday }); }
}
