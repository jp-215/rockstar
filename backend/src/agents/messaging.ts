import type { Bus } from '../bus.ts';
import type { LLMRouter } from '../llm/router.ts';
import type { TelegramAdapter } from '../adapters/telegram.ts';
import type { Customers } from '../customers.ts';
import { IntentSchema, REPLIES, SANDBOX_SYSTEM, screen, templateIntent, wrapUntrusted } from '../security/sandbox.ts';

/** Sends promos to opted-in customers and handles inbound messages inside the sandbox. */
export class MessagingAgent {
  constructor(private bus: Bus, private llm: LLMRouter, private telegram: TelegramAdapter, private customers: Customers) {
    bus.on('promo.live', (e) => void this.broadcast(e.payload.promo.id, e.payload.promo.telegramText, e.traceId));
    bus.on('comms.telegram.inbound', (e) => void this.inbound(e.payload.chatId, e.payload.name, e.payload.text, e.traceId));
  }

  private async broadcast(promoId: string, text: string, traceId: string) {
    const recipients = this.customers.optedIn();
    for (const c of recipients) await this.telegram.send(c.chatId, text);
    this.bus.publish('messaging', 'messaging.sent', { promoId, count: recipients.length, recipients: recipients.map((c) => c.name), text }, traceId);
  }

  private async inbound(chatId: string, name: string, text: string, traceId: string) {
    const reply = async (t: string) => { await this.telegram.send(chatId, t); this.bus.publish('messaging', 'messaging.reply', { chatId, text: t }, traceId); };

    // 1. Pre-screen: obvious steering attempts never reach the model.
    const s = screen(text);
    if (s.suspicious) {
      this.bus.publish('messaging', 'security.injection_blocked', { chatId, excerpt: text.slice(0, 120), reason: s.reasons.join(', ') }, traceId);
      await reply(REPLIES.blocked);
      return;
    }
    // 2. Closed-set classification; the model cannot produce actions or text.
    const { value } = await this.llm.complete({
      agent: 'messaging', task: 'classify', schema: IntentSchema, example: { intent: 'question' },
      template: () => ({ intent: templateIntent(text) }),
      system: SANDBOX_SYSTEM, user: wrapUntrusted(text), maxTokens: 60,
    });
    // 3. Code decides the side effect and the reply.
    switch (value.intent) {
      case 'join': this.customers.setOptIn(chatId, name, true); await reply(REPLIES.join); break;
      case 'stop': this.customers.setOptIn(chatId, name, false); await reply(REPLIES.stop); break;
      case 'question': await reply(REPLIES.question); break;
      default: {
        if (/promo|discount|free|coupon|deal/i.test(text)) {
          this.bus.publish('messaging', 'security.injection_blocked', { chatId, excerpt: text.slice(0, 120), reason: 'unclassified request touching promos' }, traceId);
          await reply(REPLIES.blocked);
        } else await reply(REPLIES.other);
      }
    }
  }
}
