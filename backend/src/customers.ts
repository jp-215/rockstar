import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Bus } from './bus.ts';

export interface Customer { chatId: string; name: string; optedIn: boolean; phone?: string }

const SEED: Customer[] = [
  { chatId: 'c1', name: 'Ava', optedIn: true, phone: '+14155550101' },
  { chatId: 'c2', name: 'Ben', optedIn: true, phone: '+14155550102' },
  { chatId: 'c3', name: 'Chloe', optedIn: true, phone: '+14155550103' },
  { chatId: 'c4', name: 'Dev', optedIn: false, phone: '+14155550104' },
];

/** Opt-in registry persisted as JSON; mirrors changes to the bus for the console. */
export class Customers {
  private list: Customer[];
  constructor(private bus: Bus, private path: string | null) {
    this.list = SEED.map((c) => ({ ...c }));
    if (path && existsSync(path)) { try { this.list = JSON.parse(readFileSync(path, 'utf8')); } catch { /* keep seed */ } }
    this.save();
  }
  all(): Customer[] { return this.list.map((c) => ({ ...c })); }
  optedIn(): Customer[] { return this.list.filter((c) => c.optedIn); }
  get(chatId: string): Customer | undefined { return this.list.find((c) => c.chatId === chatId); }
  setOptIn(chatId: string, name: string, optedIn: boolean) {
    const c = this.get(chatId);
    if (c) { c.optedIn = optedIn; if (name) c.name = name; } else this.list.push({ chatId, name: name || chatId, optedIn });
    this.save();
  }
  save() {
    if (this.path) { try { mkdirSync(dirname(this.path), { recursive: true }); writeFileSync(this.path, JSON.stringify(this.list, null, 2)); } catch { /* ignore */ } }
    this.bus.publish('communication', 'customers.updated', { customers: this.all() });
  }
}
