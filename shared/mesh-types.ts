// Shared message contracts between the sim (browser), the backend mesh (Node), and the TV / Comms pages.
//
// Hierarchy: the Manager agent supervises four sub-agents (communication, inventory, analytics,
// campaign). Only the Manager talks to the store owner (Telegram). Sub-agents publish to the bus;
// the Manager decides.

export type Provider = 'claude' | 'ollama' | 'template';
export type ImageProviderName = 'bfl-flux' | 'ollama-image' | 'svg-template';
export type AgentName =
  | 'sim' | 'pos' | 'manager' | 'communication' | 'inventory' | 'analytics' | 'campaign'
  | 'owner' | 'router' | 'console' | 'tv' | 'test';

export type Weather = 'clear' | 'rain' | 'overcast' | 'night';
export type CampaignKind = 'flash' | 'winback' | 'bogo';
export type CampaignColor = 'red' | 'teal' | 'gold' | 'black';

/** What the manager asks the campaign agent for. */
export interface CampaignBrief {
  id: string;
  kind: CampaignKind;
  trigger: string;             // human-readable reason
  items: string[];             // inventory items to push (bogo / winback), empty for flash
  maxDiscountPct: number;
  durationMin: number;
  metrics?: MetricsSnapshot;
}

/** A finished campaign: copy + visual assets. */
export interface Campaign {
  id: string;
  kind: CampaignKind;
  headline: string;            // e.g. "Buy one, get one free"
  subline: string;             // e.g. "Croissants, today only"
  offer: string;               // e.g. "BOGO" | "20% off" | "Free coffee with any plate"
  discountPct: number;         // POS discount applied with the code
  durationMin: number;
  code: string;                // promo code for POS
  items: string[];
  customerText: string;        // what customers receive
  color: CampaignColor;
  rationale: string;
  imageUrl: string | null;     // generated 1080×1920 JPEG (FLUX) when available
  posterUrl: string;           // always present: 1080×1920 JPEG poster rendered by code (SVG source saved beside it)
  imageProvider: ImageProviderName;
  trigger: string;
}

export interface MetricsSnapshot {
  simTime: number;
  weather: Weather;
  footfallPerMin: number;
  lookRate: number;            // 0..1
  walkIns: number;             // in window
  sales: number;               // count in window
  revenue: number;             // $ in window
  conversion: number;          // sales / walkIns
  baseline: { footfallPerMin: number; sales: number; conversion: number };
  baselineSec: number;         // history the baseline covers (0 = none yet)
  trend: 'up' | 'flat' | 'down';
}

export interface InventoryItem {
  sku: string;
  name: string;
  qty: number;
  unit: string;
  parLevel: number;            // reorder threshold
  expiresDay: number | null;   // store-day index when it goes bad (null = shelf stable)
  cost: number;                // $ per unit, for waste accounting
}

export interface InventoryState {
  day: number;                 // current store-day index
  dayLengthSec: number;        // sim-seconds per store day
  items: InventoryItem[];
  wasteToday: { sku: string; qty: number; value: number }[];
}

export interface InventoryAlert {
  kind: 'expiring' | 'low' | 'wasted';
  items: { sku: string; name: string; qty: number; daysLeft?: number; parLevel?: number; value?: number }[];
  text: string;
}

export interface DailyReport {
  day: number;
  periodSec: number;
  footfall: number;
  lookRate: number;
  walkIns: number;
  sales: number;
  revenue: number;
  conversion: number;
  campaigns: { id: string; kind: CampaignKind; headline: string; redemptions: number; approved: boolean }[];
  wasteValue: number;
  wasteAvoidedValue: number;
  weatherMix: Record<Weather, number>;
  narrative: string;
  provider: Provider;
}

export interface Topics {
  // --- simulator -> mesh
  'sim.footfall': { simTime: number; scenario: string; weather: Weather; passersby: number; lookers: number; walkIns: number; windowSec: number };
  'sim.purchased': { simTime: number; pedId: number };
  'sim.control': { action: 'scenario'; scenario: string } | { action: 'reset' };
  // --- POS
  'pos.sale': { id: string; simTime: number; amount: number; items: string[]; promoCode?: string; source: 'sim' | 'manual' };
  // --- analytics (was sensing)
  'analytics.report': MetricsSnapshot & { narrative: string; provider: Provider };
  'analytics.daily': DailyReport;
  'analytics.request': { kind: 'daily'; by: string };
  // --- inventory
  'inventory.state': InventoryState;
  'inventory.alert': InventoryAlert;
  'inventory.control': { action: 'adjust'; sku: string; delta: number } | { action: 'set_expiry'; sku: string; expiresDay: number | null } | { action: 'advance_day' } | { action: 'restock'; sku: string };
  // --- manager (supervisor)
  'manager.decision': { kind: 'campaign' | 'notify' | 'hold'; reason: string; briefId?: string };
  'manager.lift_report': { before: MetricsSnapshot; after: MetricsSnapshot; redemptions: number; text: string; campaignId: string };
  // --- campaign agent
  'campaign.brief': CampaignBrief;
  'campaign.draft': { campaign: Campaign; provider: Provider };
  'campaign.approval_requested': { campaign: Campaign; text: string };
  'campaign.approved': { campaignId: string; by: string };
  'campaign.rejected': { campaignId: string; by: string };
  'campaign.live': { campaign: Campaign; expiresAt: number };
  'campaign.expired': { campaignId: string };
  'display.set': { campaign: Campaign; expiresAt: number };
  'display.clear': { campaignId?: string };
  // --- owner channel (Telegram); only the manager publishes owner.message
  'owner.message': { text: string; kind: 'brief' | 'approval' | 'lift' | 'alert' | 'report' | 'info'; campaignId?: string; imageUrl?: string | null };
  'owner.reply': { text: string; by: string };                              // raw inbound from the owner
  'owner.action': { campaignId: string; action: 'approve' | 'reject'; by: string };
  // --- communication agent (AppleScript: notifications + iMessage, plus the TV)
  'comms.notify': { title: string; text: string; channel: 'notification' | 'imessage' | 'tv'; to?: string; ok: boolean; dryRun: boolean };
  'comms.sent': { campaignId: string; count: number; recipients: string[]; text: string };
  'comms.customer.inbound': { chatId: string; name: string; text: string };   // untrusted customer text
  'comms.customer.reply': { chatId: string; text: string };
  'customers.updated': { customers: { chatId: string; name: string; optedIn: boolean; phone?: string }[] };
  'security.injection_blocked': { chatId: string; excerpt: string; reason: string };
  // --- mesh plumbing
  'mesh.status': { provider: Provider; imageProvider: ImageProviderName; online: boolean; forcedOffline: boolean; owner: 'mock' | 'telegram'; comms: 'mock' | 'applescript' };
  'mesh.control': { action: 'force_offline'; value: boolean } | { action: 'ring_up'; amount: number; promoCode?: string } | { action: 'status' };
  'llm.call': { agent: AgentName; task: string; provider: Provider | ImageProviderName; ms: number; ok: boolean; error?: string };
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
export const HTTP_BASE = `http://${typeof location !== 'undefined' ? location.hostname : 'localhost'}:${WS_PORT}`;
export const WS_URL = `ws://${typeof location !== 'undefined' ? location.hostname : 'localhost'}:${WS_PORT}/ws`;
