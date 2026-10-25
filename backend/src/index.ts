import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { Bus } from './bus.ts';
import { LLMRouter } from './llm/router.ts';
import { makeSlack } from './adapters/slack.ts';
import { makeTelegram } from './adapters/telegram.ts';
import { Customers } from './customers.ts';
import { MockPOS } from './pos.ts';
import { SensingAgent } from './agents/sensing.ts';
import { ManagerAgent } from './agents/manager.ts';
import { MarketingAgent } from './agents/marketing.ts';
import { MessagingAgent } from './agents/messaging.ts';
import { WS_PORT } from '../../shared/mesh-types.ts';

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = resolve(here, '../data');

export interface MeshOptions { port?: number | null; log?: boolean; demoMinutes?: number }

/** Boots the whole mesh in one process. Returns handles so tests can drive it without sockets. */
export async function startMesh(opts: MeshOptions = {}) {
  const bus = new Bus({ port: opts.port === null ? undefined : (opts.port ?? WS_PORT), logPath: opts.log === false ? null : resolve(dataDir, 'log.jsonl') });
  const router = new LLMRouter(bus);
  const slack = makeSlack(bus);
  const telegram = makeTelegram(bus);
  const customers = new Customers(bus, opts.log === false ? null : resolve(dataDir, 'customers.json'));
  const pos = new MockPOS(bus);
  const agents = {
    sensing: new SensingAgent(bus, router),
    manager: new ManagerAgent(bus, router, slack),
    marketing: new MarketingAgent(bus, router, { demoMinutes: opts.demoMinutes ?? (process.env.MESH_PROMO_MINUTES ? Number(process.env.MESH_PROMO_MINUTES) : undefined) }),
    messaging: new MessagingAgent(bus, router, telegram, customers),
  };

  const publishStatus = async () => {
    const s = await router.status();
    bus.publish('router', 'mesh.status', { ...s, adapters: { slack: slack.kind, telegram: telegram.kind } });
  };
  router.onStatus = () => void publishStatus();
  bus.on('mesh.control', (e) => {
    if (e.payload.action === 'force_offline') router.setForcedOffline(e.payload.value);
    if (e.payload.action === 'status') { void publishStatus(); customers.save(); }
  });

  await slack.start().catch((e) => console.error('[slack] start failed, continuing in mock-visible mode', e));
  await telegram.start().catch((e) => console.error('[telegram] start failed', e));
  await publishStatus();
  if (router.ollamaModel) console.info(`[mesh] local fallback model: ${router.ollamaModel}`);
  const statusTimer = setInterval(() => void publishStatus(), 20_000);

  console.info(`[mesh] up · slack=${slack.kind} telegram=${telegram.kind}`);
  return { bus, router, slack, telegram, customers, pos, agents, stop: () => { clearInterval(statusTimer); bus.close(); } };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startMesh().catch((e) => { console.error(e); process.exit(1); });
}
