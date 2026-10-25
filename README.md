# Market Street Storefront: Simulator + Agent Mesh

A small café on Market Street, San Francisco, simulated in 3D in the browser, plus a supervised
agent mesh that turns foot traffic, weather and inventory into campaigns the owner approves on
Telegram. This README is written so another agent (or engineer) can see what happens internally and
change it safely.

## The hierarchy

```
                         Store owner (Telegram)
                                  ▲ only this link
                                  │
                           ┌──────┴──────┐
                           │   Manager   │  supervisor: reads signals, decides, briefs, approvals, lift + daily reports
                           └──┬───┬───┬──┴┬
              ┌───────────────┘   │   │   └────────────────┐
     ┌────────┴───────┐  ┌────────┴──┐  ┌──┴──────────┐  ┌──┴──────────────┐
     │ Communication  │  │ Inventory │  │ Analytics   │  │ Campaign        │
     │ notifications, │  │ stock,    │  │ trends,     │  │ copy (text LLM) │
     │ iMessage, TV,  │  │ expiry,   │  │ daily       │  │ + image (FLUX)  │
     │ sandboxed      │  │ waste     │  │ report      │  │ + SVG poster    │
     │ inbound text   │  │           │  │             │  │                 │
     └───────┬────────┘  └─────┬─────┘  └──────┬──────┘  └────────┬────────┘
             │                 │               │                  │
             └─────────────────┴───── bus ─────┴──────────────────┘
                                       ▲
                          Sim (browser) · Mock POS · TV page · Console
```

Rules that define the hierarchy:
- Sub-agents publish signals and results to the bus; the **Manager** decides what to do with them.
- The Manager is the **only** agent that publishes `owner.message` and holds the Telegram adapter.
- Every campaign goes to the owner for approval (`APPROVE` / `REJECT` on Telegram) before anything
  reaches the TV or customers.
- Models write prose and classify; **code** decides side effects (zod-validated JSON everywhere).

## What triggers a campaign

| Trigger | Detected by | Manager decision | Campaign kind |
|---|---|---|---|
| Traffic up ≥ 30 % vs baseline, sales flat or conversion down | Analytics | brief owner, draft a flash promo | `flash` (≤ 20 %) |
| Light traffic (trend down or < 8/min) or rain/overcast with footfall below baseline | Analytics (weather comes from the sim) | win-back offer | `winback` (≤ 15 %) |
| Stock within 4 days of expiry | Inventory | sell it before it goes bad | `bogo` (buy one get one, 50 %) |
| Stock at or below par level | Inventory | alert the owner to reorder (no campaign) | — |
| Stock thrown out at day change | Inventory | waste alert to the owner | — |

Cooldowns per kind, one campaign at a time, and a baseline of at least 3 sim-minutes before judging.

## Repository layout

```
rockstar/
  package.json          npm workspaces (frontend, backend) + root scripts
  CLAUDE.md             conventions for agents working in this repo
  .env.example          every environment variable, documented
  shared/mesh-types.ts  every bus topic + payload type; imported by both packages
  frontend/             Vite + TypeScript + Three.js (no framework)
    index.html          3D simulator                      -> src/main.ts
    tv.html             TV display (kiosk)                -> src/tv/main.ts
    comms.html          Console: owner phone, customer phones, inventory, POS, trace -> src/comms/main.ts
    src/world/          scene, street block, storefront (interior, banner, portrait TV in the window), weather
    src/agents/         pedestrian model, behaviour state machine, crowd spawner
    src/sensing/        storefront camera + gaze detector
    src/manager/        in-browser metrics, alert rules, side panel
    src/mesh/           WebSocket client to the backend bus
    src/config.ts       all sim tunables incl. scenarios (spawn, interest, speed, purchase multipliers, weather)
  backend/              Node 20+ (tsx), one process
    src/index.ts        boots bus, routers, adapters, POS, customers, agents  (startMesh())
    src/bus.ts          typed pub/sub + WebSocket mirror (/ws) + asset server (/assets) on :8787 + JSONL log
    src/llm/            text providers (Claude, Ollama opt-in, template) + router; image router (BFL FLUX API, Ollama image endpoint, SVG poster)
    src/env.ts          loads .env files (root, backend/, frontend/) without overriding the shell
    src/agents/         manager, communication, inventory, analytics, campaign
    src/adapters/       owner.ts (Telegram mock | grammY), applescript.ts (notifications, iMessage dry-run)
    src/security/       inbound-message sandbox
    src/pos.ts          mock point of sale (menu, campaign codes, promoted items)
    src/customers.ts    opt-in registry (backend/data/customers.json)
    test/scenario.ts    headless end-to-end run of all three campaign paths (npm test)
    test/bench-models.ts benchmark local Ollama models on the real agent workloads
    test/smoke-apis.ts  tiny calls to verify ANTHROPIC_API_KEY and FLUX_API_KEY
    data/               runtime: log.jsonl, customers.json, assets/<campaignId>/  (gitignored)
```

## Run

```sh
npm install
npm run dev:all        # frontend http://localhost:5173, backend ws://localhost:8787/ws + http://localhost:8787/assets
npm test               # backend end-to-end: flash, BOGO, win-back, sandbox, daily report (~25 s, deterministic)
npm run typecheck      # both packages
npm run build          # frontend production bundle in frontend/dist
```

Open three tabs: Sim `/` (Street and Storefront-cam views), TV `/tv.html` (portrait monitor mirror), Console `/comms.html`.

### Keys and models

Put keys in a `.env` at the repo root (the backend also reads `frontend/.env`; nothing without a `VITE_`
prefix ever reaches the browser). See `.env.example` for every variable.

| Variable | Effect | Fallback when missing |
|---|---|---|
| `ANTHROPIC_API_KEY` | Claude `claude-opus-5-5` writes briefs, campaign copy, narratives, classifies customer text | Ollama if `OLLAMA_ENABLED=1`, else templates |
| `FLUX_API_KEY` | Black Forest Labs FLUX (`FLUX_MODEL`, default `flux-dev`) generates the 1080×1920 campaign image | Ollama image model if `OLLAMA_IMAGE_ENABLED=1`, else the SVG poster |
| `TELEGRAM_BOT_TOKEN` + `OWNER_TELEGRAM_CHAT_ID` | real owner channel | console mock phone |
| `COMMS_APPLESCRIPT` / `COMMS_IMESSAGE` | macOS notifications (on by default on macOS) / real iMessages (off) | mock / dry-run |

`npx tsx backend/test/smoke-apis.ts` checks the keys with tiny calls. `npm test` uses Claude when a key
is present and never calls the image API unless `KEEP_ASSETS=1` (it then also keeps `backend/data/assets`).
On the Kubernetes environment the same code runs on local models: `OLLAMA_ENABLED=1 OLLAMA_MODEL=qwen3:4b`
and `OLLAMA_IMAGE_ENABLED=1 OLLAMA_IMAGE_MODEL=flux2-klein:4b`. **Simulate offline** in the console
disables both hosted APIs at once.

### Demo script

1. `npm run dev:all`; open the three pages. Console header shows brain, image provider, owner and
   comms adapter modes.
2. **Flash.** Sim: Regular day for about a minute (baseline), speed 4×, then **Dinner rush**. The
   owner phone in the console gets a brief, then an approval card with the poster. Approve. TV flips,
   the storefront banner and poster change, the three opted-in customer phones get the iMessage
   (dry-run), the Mac shows a notification, POS records code sales, the owner gets the lift report.
3. **BOGO.** Console: **Advance day** twice. Inventory shows croissants, sourdough and salmon within
   4 days. The manager briefs the owner and the campaign agent drafts "Buy one, get one free" with
   those items; approve; POS sales skew to the promoted items.
4. **Win-back.** Sim: **Rainy day** (or Dead hours). Analytics reports rain and light traffic; the
   manager proposes a win-back offer. Reject it to show the gate works.
5. **Report.** Owner phone: **Report**. Analytics builds the day's numbers (traffic, conversion,
   campaigns and redemptions, waste and sales on expiring stock); the manager relays it.
6. **Offline.** Tick **Simulate offline** (or turn wifi off). Brain badge shows template; repeat any step.
7. **Injection.** Customer phone: **Inject attempt**. Blocked by the sandbox, canned reply, security
   note to the owner, TV unchanged.

## How the pieces talk: the bus

`backend/src/bus.ts` is an in-process typed pub/sub. Every `publish(from, topic, payload)` creates an
`Envelope { id, ts, topic, from, traceId, payload }`, appends it to `backend/data/log.jsonl`, mirrors it
to every WebSocket client, and delivers to handlers on the next microtask. The same HTTP server serves
`/assets/<campaignId>/poster.svg|image.png`. Browser pages use `frontend/src/mesh/meshClient.ts`.

Topics are declared once in `shared/mesh-types.ts`. In the order they usually fire:

| Topic | From → to | Meaning |
|---|---|---|
| `mesh.status` | router → pages | text/image provider, online flag, owner and comms adapter modes |
| `inventory.state` | inventory → console | day, items (qty, par, expiry day), waste today |
| `customers.updated` | communication → console | opt-in registry |
| `sim.footfall` | sim → analytics, inventory | 5 sim-second batch: passersby, lookers, walkIns, weather |
| `sim.purchased` | sim → POS | a pedestrian bought something |
| `pos.sale` | POS → analytics, inventory, manager | priced sale, items, optional code |
| `analytics.report` | analytics → manager, console | window metrics, baseline, trend, weather, narrative |
| `inventory.alert` | inventory → manager, analytics | `expiring` (≤ 4 days), `low` (≤ par), `wasted` |
| `manager.decision` | manager → console | what the manager decided and why |
| `campaign.brief` | manager → campaign | kind, trigger, items, max discount, duration |
| `campaign.draft` | campaign → manager, analytics | finished campaign with posterUrl (+ imageUrl when a model ran) |
| `owner.message` | **manager only** → owner adapter, console | brief / approval / lift / alert / report / info |
| `owner.reply` | owner adapter or console → manager | raw owner text (APPROVE, REJECT, REPORT, STATUS) |
| `owner.action` / `campaign.approved` / `campaign.rejected` | manager | decision |
| `display.set` / `display.clear` | campaign → TV page, sim | the campaign JPEG goes onto the storefront TV (sim) and the TV page |
| `campaign.live` / `campaign.expired` | campaign → communication, POS, manager | lifecycle |
| `comms.notify` | communication → console | each notification / iMessage / TV push with ok + dryRun |
| `comms.sent` | communication → manager | broadcast summary |
| `comms.customer.inbound` / `comms.customer.reply` | console or channel ↔ communication | untrusted customer text and the coded reply |
| `security.injection_blocked` | communication → manager | sandbox verdict |
| `manager.lift_report` | manager → console | before/after + redemptions |
| `analytics.request` / `analytics.daily` | manager → analytics → manager | owner asked for the report; the report |
| `sim.control` / `inventory.control` / `mesh.control` | console → sim / inventory / backend | scenario, reset, stock edits, advance day, force offline, ring up |
| `llm.call` | routers → console | trace per model call: agent, task, provider, ms, ok |

## Agent internals

**Manager** (`agents/manager.ts`). Holds the latest analytics snapshot, pending and live campaign,
per-kind cooldowns. `onReport` applies the flash and win-back rules; `onInventory` applies the BOGO,
low-stock and waste rules. `brief()` publishes `manager.decision` + `campaign.brief`. `requestApproval`
sends the owner the draft (with poster) and waits. `onOwnerText` parses APPROVE / REJECT / REPORT /
STATUS and replies with help otherwise. `maybeLift` posts the result after the first code redemption
(or an interim after 5 sim-minutes). `tell()` is the single door to the owner.

**Analytics** (`agents/analytics.ts`). Rolling 5-minute window vs prior 30-minute baseline on sim time,
`trend` at ±30 %, weather carried through. Daily report on request or day change: footfall, look rate,
walk-ins, sales, revenue, conversion, campaigns with redemptions, waste value, sales on expiring stock.

**Inventory** (`agents/inventory.ts`). Nine seeded items with par levels and expiry on a store-day
clock (`MESH_DAY_SEC` sim-seconds per day, forward-only, reset with the sim). POS sales consume stock
through recipes. Alerts once per item per day (expiring) or until restocked (low); at day change,
expired stock is thrown out and reported as waste.

**Campaign** (`agents/campaign.ts`). Brief → copy (text model, kind-specific template fallback) →
clamps (discount ≤ brief max, code `FLASH20` / `WARM15` / `BOGO`) → poster always (SVG source rendered
to a **1080×1920 JPEG** with sharp) → hero image at the same size when `OLLAMA_IMAGE_ENABLED=1` and the
model is installed → `campaign.draft`. The JPEG is what the storefront TV shows. On approval:
`display.set` + `campaign.live` and an expiry timer.

**Communication** (`agents/communication.ts`). On `campaign.live`: macOS notification, TV push (the
TV listens to `display.set`), iMessage to each opted-in customer (dry-run unless enabled). Inbound
customer text goes through the sandbox: regex pre-screen → closed-set intent classification → code
picks the side effect (opt in / out) and a canned reply. Nothing a customer types can reach the owner
channel, approvals, or the display.

**Mock POS** (`pos.ts`). Prices sim purchases from the menu; during a campaign 70 % of sales redeem
the code and, for item campaigns, skew to the promoted items; `ring_up` makes a manual sale.

### Models

| Role | Online | Local (cluster) | Offline floor |
|---|---|---|---|
| Manager, Communication, Inventory, Analytics, Campaign copy | Claude `claude-opus-5-5`, structured output | Ollama `qwen3:4b` (or `qwen3:1.7b`, `llama3.2:3b`) via `OLLAMA_ENABLED=1` | templates |
| Campaign image | BFL FLUX API (`FLUX_API_KEY`, `flux-dev`), 832×1440 upscaled to 1080×1920 | Ollama experimental image endpoint, `flux2-klein:4b`, via `OLLAMA_IMAGE_ENABLED=1` | SVG poster |

`backend/test/bench-models.ts` runs the real workloads (classify, promo draft, narrative) against any
installed Ollama model and prints latency and schema validity. On an 8 GB laptop stay at 1B to 4B.

## Extending

- New signal: add a topic to `Topics`, publish it from the sub-agent, add a rule in the Manager.
- New channel: implement the adapter interface in `backend/src/adapters/`, keep the mock, gate on env.
- New campaign kind: extend `CampaignKind`, add a template in `CampaignAgent.templateFor`, a code
  prefix, and a Manager trigger.

## Verification

- `npm test` drives a fake sim feed through all three paths and asserts: no premature expiring
  alerts; flash brief → draft (≤ 20 %, poster.svg) → owner approval request from the manager only →
  APPROVE → live → TV → 3 customers messaged → code sale → lift → expiry; day advance → expiring alert
  → BOGO brief with items → draft (50 %, `BOGO`) → approve → BOGO sales; rain + no traffic → win-back
  brief → draft (≤ 15 %) → REJECT; injection blocked with owner security note and TV unchanged; JOIN
  opts in; REPORT yields a daily report relayed to the owner.
- The browser demo has been driven headlessly with Playwright across the three pages.

## Not in this version

Real computer vision, Blender assets, a hosted image API, reading iMessage replies via AppleScript,
and Kubernetes manifests (the cluster work is tracked separately).
