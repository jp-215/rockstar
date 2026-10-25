import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { Bus } from './bus.ts';
import { LLMRouter } from './llm/router.ts';
import { ImageRouter } from './llm/image.ts';
import { makeOwner } from './adapters/owner.ts';
import { makeComms } from './adapters/applescript.ts';
import { Customers } from './customers.ts';
import { MockPOS } from './pos.ts';
import { AnalyticsAgent } from './agents/analytics.ts';
import { InventoryAgent } from './agents/inventory.ts';
import { CampaignAgent } from './agents/campaign.ts';
import { CommunicationAgent } from './agents/communication.ts';
import { ManagerAgent } from './agents/manager.ts';
import { WS_PORT } from '../../shared/mesh-types.ts';

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = resolve(here, '../data');

export interface MeshOptions { port?: number | null; log?: boolean; demoMinutes?: number }

/**
 * Boots the whole mesh in one process:
 *   Manager (supervisor, owner channel) ── Communication / Inventory / Analytics / Campaign sub-agents
 * Returns handles so tests can drive it without sockets.
 */
export async function startMesh(opts: MeshOptions = {}) {
  const port = opts.port === null ? undefined : (opts.port ?? WS_PORT);
  const persist = opts.log !== false;
  const bus = new Bus({ port, logPath: persist ? resolve(dataDir, 'log.jsonl') : null, assetsDir: persist ? resolve(dataDir, 'assets') : null });
  const router = new LLMRouter(bus);
  const images = new ImageRouter(bus, bus.assetsDir);
  const publicBase = process.env.MESH_PUBLIC_BASE ?? `http://localhost:${port ?? WS_PORT}`;
  const owner = makeOwner(bus, publicBase);
  const comms = makeComms(bus);
  const customers = new Customers(bus, persist ? resolve(dataDir, 'customers.json') : null);
  const pos = new MockPOS(bus);
  const demoMinutes = opts.demoMinutes ?? (process.env.MESH_PROMO_MINUTES ? Number(process.env.MESH_PROMO_MINUTES) : undefined);
  const agents = {
    analytics: new AnalyticsAgent(bus, router),
    inventory: new InventoryAgent(bus),
    campaign: new CampaignAgent(bus, router, images, { demoMinutes }),
    communication: new CommunicationAgent(bus, router, comms, customers),
    manager: new ManagerAgent(bus, router, owner),
  };

  const publishStatus = async () => {
    const s = await router.status();
    bus.publish('router', 'mesh.status', { ...s, imageProvider: await images.providerName(), owner: owner.kind, comms: comms.kind });
  };
  router.onStatus = () => void publishStatus();
  bus.on('mesh.control', (e) => {
    if (e.payload.action === 'force_offline') router.setForcedOffline(e.payload.value);
    if (e.payload.action === 'status') { void publishStatus(); customers.save(); }
  });

  await owner.start().catch((e) => console.error('[owner] start failed', e));
  await publishStatus();
  const statusTimer = setInterval(() => void publishStatus(), 20_000);
  console.info(`[mesh] up · owner=${owner.kind} comms=${comms.kind} assets=${bus.assetsDir ?? 'memory'}`);
  return { bus, router, images, owner, comms, customers, pos, agents, stop: () => { clearInterval(statusTimer); bus.close(); } };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startMesh().catch((e) => { console.error(e); process.exit(1); });
}
