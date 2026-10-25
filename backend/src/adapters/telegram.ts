import type { Bus } from '../bus.ts';

export interface TelegramAdapter {
  readonly kind: 'mock' | 'real';
  start(): Promise<void>;
  send(chatId: string, text: string): Promise<void>;
}

/** Mock: outbound goes to the bus; the Comms console renders phones and publishes inbound text. */
export class TelegramMock implements TelegramAdapter {
  readonly kind = 'mock' as const;
  constructor(private bus: Bus) {}
  async start() {}
  async send(chatId: string, text: string) { this.bus.publish('telegram', 'comms.telegram.outbound', { chatId, text }); }
}

/** Real Telegram bot via grammY long polling. Loaded only when TELEGRAM_BOT_TOKEN is present. */
export class TelegramReal implements TelegramAdapter {
  readonly kind = 'real' as const;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private bot: any = null;
  constructor(private bus: Bus) {}

  async start() {
    const mod = 'grammy';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { Bot } = (await import(/* @vite-ignore */ mod)) as any;
    this.bot = new Bot(process.env.TELEGRAM_BOT_TOKEN);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.bot.on('message:text', (ctx: any) => {
      const chatId = String(ctx.chat.id);
      const name = ctx.from?.first_name ?? chatId;
      const text: string = ctx.message.text;
      this.bus.publish('telegram', 'comms.telegram.inbound', { chatId, name, text: text === '/start' ? 'JOIN' : text });
    });
    void this.bot.start();
    console.info('[telegram] polling');
  }

  async send(chatId: string, text: string) {
    try { await this.bot.api.sendMessage(chatId, text); } catch (e) { console.warn('[telegram] send failed', e); }
    this.bus.publish('telegram', 'comms.telegram.outbound', { chatId, text });
  }
}

export function makeTelegram(bus: Bus): TelegramAdapter {
  return process.env.TELEGRAM_BOT_TOKEN ? new TelegramReal(bus) : new TelegramMock(bus);
}
