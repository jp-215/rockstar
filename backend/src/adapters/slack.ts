import type { Bus } from '../bus.ts';
import type { Promo } from '../../../shared/mesh-types.ts';

export interface SlackAdapter {
  readonly kind: 'mock' | 'real';
  start(): Promise<void>;
  post(text: string, kind: 'brief' | 'lift' | 'security' | 'info'): Promise<void>;
  requestApproval(promo: Promo, text: string): Promise<void>;
}

/** Mock: posts go to the bus; the Comms console renders them and publishes comms.slack.action. */
export class SlackMock implements SlackAdapter {
  readonly kind = 'mock' as const;
  constructor(private bus: Bus) {}
  async start() {}
  async post(text: string, kind: 'brief' | 'lift' | 'security' | 'info') { this.bus.publish('slack', 'comms.slack.post', { text, kind }); }
  async requestApproval(promo: Promo, text: string) { this.bus.publish('slack', 'comms.slack.post', { text, kind: 'approval', promoId: promo.id }); }
}

/** Real Slack via Bolt in Socket Mode (no public URL). Loaded only when tokens are present. */
export class SlackReal implements SlackAdapter {
  readonly kind = 'real' as const;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private app: any = null;
  constructor(private bus: Bus, private channel: string) {}

  async start() {
    const mod = '@slack/bolt';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { App } = (await import(/* @vite-ignore */ mod)) as any;
    this.app = new App({ token: process.env.SLACK_BOT_TOKEN, appToken: process.env.SLACK_APP_TOKEN, socketMode: true });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.app.action(/promo_(approve|reject)/, async ({ ack, action, body }: any) => {
      await ack();
      const promoId = String(action.value);
      const act = String(action.action_id).endsWith('approve') ? 'approve' : 'reject';
      this.bus.publish('slack', 'comms.slack.action', { promoId, action: act, by: body.user?.name ?? body.user?.id ?? 'owner' });
    });
    await this.app.start();
    console.info('[slack] connected (socket mode)');
  }

  async post(text: string, kind: 'brief' | 'lift' | 'security' | 'info') {
    const icon = { brief: ':bar_chart:', lift: ':chart_with_upwards_trend:', security: ':shield:', info: ':information_source:' }[kind];
    await this.app.client.chat.postMessage({ channel: this.channel, text: `${icon} ${text}` });
    this.bus.publish('slack', 'comms.slack.post', { text, kind });
  }

  async requestApproval(promo: Promo, text: string) {
    await this.app.client.chat.postMessage({
      channel: this.channel, text,
      blocks: [
        { type: 'section', text: { type: 'mrkdwn', text } },
        { type: 'section', text: { type: 'mrkdwn', text: `*${promo.headline}*\n${promo.subline}\nCode \`${promo.code}\` · ${promo.discountPct}% off · ${promo.durationMin} min` } },
        { type: 'actions', elements: [
          { type: 'button', style: 'primary', text: { type: 'plain_text', text: 'Approve' }, action_id: 'promo_approve', value: promo.id },
          { type: 'button', style: 'danger', text: { type: 'plain_text', text: 'Reject' }, action_id: 'promo_reject', value: promo.id },
        ] },
      ],
    });
    this.bus.publish('slack', 'comms.slack.post', { text, kind: 'approval', promoId: promo.id });
  }
}

export function makeSlack(bus: Bus): SlackAdapter {
  if (process.env.SLACK_BOT_TOKEN && process.env.SLACK_APP_TOKEN && process.env.SLACK_CHANNEL) return new SlackReal(bus, process.env.SLACK_CHANNEL);
  return new SlackMock(bus);
}
