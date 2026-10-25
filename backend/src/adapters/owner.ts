import type { Bus } from '../bus.ts';

/**
 * The store owner's channel: Telegram. Only the Manager agent sends through it.
 * Inbound text from the owner is published as owner.reply; the Manager interprets it.
 */
export interface OwnerChannel {
  readonly kind: 'mock' | 'telegram';
  start(): Promise<void>;
  send(text: string, imageUrl?: string | null): Promise<void>;
}

/** Mock: the Comms console renders owner.message and publishes owner.reply / owner.action. */
export class OwnerMock implements OwnerChannel {
  readonly kind = 'mock' as const;
  async start() {}
  async send() {}
}

/** Real Telegram via grammY long polling, restricted to OWNER_TELEGRAM_CHAT_ID. */
export class OwnerTelegram implements OwnerChannel {
  readonly kind = 'telegram' as const;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private bot: any = null;
  constructor(private bus: Bus, private chatId: string, private publicBase: string) {}

  async start() {
    const mod = 'grammy';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { Bot } = (await import(/* @vite-ignore */ mod)) as any;
    this.bot = new Bot(process.env.TELEGRAM_BOT_TOKEN);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.bot.on('message:text', (ctx: any) => {
      if (String(ctx.chat.id) !== this.chatId) { void ctx.reply('This bot only talks to the store owner.'); return; }
      this.bus.publish('owner', 'owner.reply', { text: ctx.message.text, by: ctx.from?.first_name ?? 'owner' });
    });
    void this.bot.start();
    console.info('[owner] telegram polling');
  }

  async send(text: string, imageUrl?: string | null) {
    try {
      if (imageUrl && imageUrl.endsWith('.png')) await this.bot.api.sendPhoto(this.chatId, `${this.publicBase}${imageUrl}`, { caption: text });
      else await this.bot.api.sendMessage(this.chatId, text);
    } catch (e) { console.warn('[owner] telegram send failed', e); }
  }
}

export function makeOwner(bus: Bus, publicBase: string): OwnerChannel {
  if (process.env.TELEGRAM_BOT_TOKEN && process.env.OWNER_TELEGRAM_CHAT_ID) return new OwnerTelegram(bus, process.env.OWNER_TELEGRAM_CHAT_ID, publicBase);
  return new OwnerMock();
}
