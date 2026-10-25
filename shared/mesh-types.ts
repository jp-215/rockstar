// Shared message contracts between the sim (browser), the mesh (Node), and the TV / Comms pages.

export type Provider = 'claude' | 'ollama' | 'template';
export type AgentName = 'sim' | 'pos' | 'sensing' | 'manager' | 'marketing' | 'messaging' | 'slack' | 'telegram' | 'router' | 'console' | 'tv' | 'test';

export interface Promo {
  id: string;
  headline: string;      // e.g. "20% OFF — next 30 min"
  subline: string;       // e.g. "Show this message at the counter"
  discountPct: number;   // clamped to policy max
  durationMin: number;
  telegramText: string;  // customer-facing message
  color: 'red' | 'teal' | 'gold' | 'black';
  code: string;          // promo code used by POS
  rationale: string;     // why this promo, for the owner
}

export interface MetricsSnapshot {
  simTime: number;
  footfallPerMin: number;
  lookRate: number;        // 0..1
  walkIns: number;         // in window
  sales: number;           // count in window
  revenue: number;         // $ in window
  conversion: number;      // sales / walkIns (0 when no walk-ins)
  baseline: { footfallPerMin: number; sales: number; conversion: number };
  baselineSec: number;     // how much history the baseline covers (0 = none yet)
  trend: 'up' | 'flat' | 'down';
}

export interface Topics {
  'sim.footfall': { simTime: number; scenario: string; passersby: number; lookers: number; walkIns: number; windowSec: number };
  'sim.purchased': { simTime: number; pedId: number };
  'sim.control': { action: 'scenario'; scenario: string } | { action: 'reset' };
  'pos.sale': { id: string; simTime: number; amount: number; items: string[]; promoCode?: string; source: 'sim' | 'manual' };
  'sensing.report': MetricsSnapshot & { narrative: string; provider: Provider };
  'manager.opportunity': { reason: string; metrics: MetricsSnapshot };
  'manager.brief': { text: string; kind: 'brief' | 'lift' | 'security' | 'info' };
  'manager.lift_report': { before: MetricsSnapshot; after: MetricsSnapshot; promoSales: number; text: string };
  'marketing.promo_draft': { promo: Promo; provider: Provider };
  'promo.approval_requested': { promo: Promo; text: string };
  'promo.approved': { promoId: string; by: string };
  'promo.rejected': { promoId: string; by: string };
  'promo.live': { promo: Promo; expiresAt: number };
  'promo.expired': { promoId: string };
  'display.set': { promo: Promo; expiresAt: number };
  'display.clear': { promoId?: string };
  'messaging.sent': { promoId: string; count: number; recipients: string[]; text: string };
  'messaging.reply': { chatId: string; text: string };
  'comms.slack.action': { promoId: string; action: 'approve' | 'reject'; by: string };
  'comms.slack.post': { text: string; kind: 'brief' | 'approval' | 'lift' | 'security' | 'info'; promoId?: string };
  'comms.telegram.inbound': { chatId: string; name: string; text: string };
  'comms.telegram.outbound': { chatId: string; text: string };
  'customers.updated': { customers: { chatId: string; name: string; optedIn: boolean }[] };
  'security.injection_blocked': { chatId: string; excerpt: string; reason: string };
  'mesh.status': { provider: Provider; online: boolean; forcedOffline: boolean; adapters: { slack: 'mock' | 'real'; telegram: 'mock' | 'real' } };
  'mesh.control': { action: 'force_offline'; value: boolean } | { action: 'ring_up'; amount: number; promoCode?: string } | { action: 'status' };
  'llm.call': { agent: AgentName; task: string; provider: Provider; ms: number; ok: boolean; error?: string };
}

export type Topic = keyof Topics;

export interface Envelope<T extends Topic = Topic> {
  id: string;
  ts: number;          // wall-clock ms
  topic: T;
  from: AgentName;
  traceId: string;
  payload: Topics[T];
}

export const WS_PORT = 8787;
export const WS_URL = `ws://${typeof location !== 'undefined' ? location.hostname : 'localhost'}:${WS_PORT}`;
