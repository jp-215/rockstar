import type { Bus } from '../bus.ts';
import type { LLMRouter } from '../llm/router.ts';
import type { CommsChannel } from '../adapters/applescript.ts';
import type { Customers } from '../customers.ts';
import { IntentSchema, REPLIES, SANDBOX_SYSTEM, screen, templateIntent, wrapUntrusted } from '../security/sandbox.ts';

/**
 * Communication sub-agent: customer-facing channels (macOS notifications, iMessage, the TV via
 * display.set) and sandboxed inbound customer messages. It never talks to the owner; that is the
 * Manager's job.
 */
export class CommunicationAgent {
  constructor(private bus: Bus, private llm: LLMRouter, private comms: CommsChannel, private customers: Customers) {
    bus.on('campaign.live', (e) => void this.broadcast(e.payload.campaign.id, e.payload.campaign.headline, e.payload.campaign.customerText, e.traceId));
    bus.on('campaign.expired', (e) => void this.notify('Campaign ended', `Campaign ${e.payload.campaignId} has expired; the TV is back to the menu.`, e.traceId));
    bus.on('comms.customer.inbound', (e) => void this.inbound(e.payload.chatId, e.payload.name, e.payload.text, e.traceId));
  }

  private async notify(title: string, text: string, traceId: string) {
    const ok = await this.comms.notify(title, text);
    this.bus.publish('communication', 'comms.notify', { title, text, channel: 'notification', ok, dryRun: this.comms.kind === 'mock' }, traceId);
  }

  private async broadcast(campaignId: string, headline: string, text: string, traceId: string) {
    await this.notify(`Campaign live: ${headline}`, text, traceId);
    this.bus.publish('communication', 'comms.notify', { title: headline, text, channel: 'tv', ok: true, dryRun: false }, traceId);
    const recipients = this.customers.optedIn();
    for (const c of recipients) {
      const r = await this.comms.imessage(c.phone ?? c.chatId, text);
      this.bus.publish('communication', 'comms.notify', { title: headline, text, channel: 'imessage', to: c.name, ok: r.ok, dryRun: r.dryRun }, traceId);
    }
    this.bus.publish('communication', 'comms.sent', { campaignId, count: recipients.length, recipients: recipients.map((c) => c.name), text }, traceId);
  }

  private async inbound(chatId: string, name: string, text: string, traceId: string) {
    const reply = async (t: string) => {
      const c = this.customers.get(chatId);
      const r = await this.comms.imessage(c?.phone ?? chatId, t);
      this.bus.publish('communication', 'comms.customer.reply', { chatId, text: t }, traceId);
      this.bus.publish('communication', 'comms.notify', { title: 'Reply', text: t, channel: 'imessage', to: name, ok: r.ok, dryRun: r.dryRun }, traceId);
    };
    const s = screen(text);
    if (s.suspicious) {
      this.bus.publish('communication', 'security.injection_blocked', { chatId, excerpt: text.slice(0, 120), reason: s.reasons.join(', ') }, traceId);
      await reply(REPLIES.blocked);
      return;
    }
    const { value } = await this.llm.complete({
      agent: 'communication', task: 'classify', schema: IntentSchema, example: { intent: 'question' },
      template: () => ({ intent: templateIntent(text) }), system: SANDBOX_SYSTEM, user: wrapUntrusted(text), maxTokens: 60,
    });
    switch (value.intent) {
      case 'join': this.customers.setOptIn(chatId, name, true); await reply(REPLIES.join); break;
      case 'stop': this.customers.setOptIn(chatId, name, false); await reply(REPLIES.stop); break;
      case 'question': await reply(REPLIES.question); break;
      default:
        if (/promo|discount|free|coupon|deal/i.test(text)) {
          this.bus.publish('communication', 'security.injection_blocked', { chatId, excerpt: text.slice(0, 120), reason: 'unclassified request touching promos' }, traceId);
          await reply(REPLIES.blocked);
        } else await reply(REPLIES.other);
    }
  }
}
