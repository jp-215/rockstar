# Market Street Storefront: Simulator + Agent Mesh

A small café on Market Street, San Francisco, simulated in 3D in the browser, plus a four-agent
backend that turns foot traffic into action. This README is written so another agent (or engineer)
can understand what happens internally and change it safely.

## The workflow this repo implements

| Step | What happens | Where |
|---|---|---|
| 1 | Pedestrians walk past the storefront camera; footfall, gaze, walk-ins and purchases are counted | `frontend/` sim |
| 2 | Sensing agent keeps rolling windows on sim time and publishes trend reports | `backend/src/agents/sensing.ts` |
| 3 | Manager agent sees traffic up but sales flat, briefs the owner in Slack | `backend/src/agents/manager.ts` |
| 4 | Marketing agent drafts a 20 %-off flash promo; owner approves in Slack | `backend/src/agents/marketing.ts` |
| 5 | TV page switches to the promo; messaging agent texts opted-in customers on Telegram | `frontend/tv.html`, `backend/src/agents/messaging.ts` |
| 6 | Mock POS records sales with the promo code; manager reports the lift in Slack | `backend/src/pos.ts`, manager |
| 7 | Wifi off: the LLM router falls back to deterministic templates, mocks keep running on the LAN | `backend/src/llm/router.ts` |
| 8 | A customer message with an injection attempt is sandboxed and reported | `backend/src/security/sandbox.ts` |

## Repository layout

```
rockstar/
  package.json          npm workspaces (frontend, backend) + root scripts
  CLAUDE.md             conventions for agents working in this repo
  shared/mesh-types.ts  every bus topic + payload type; imported by both packages
  frontend/             Vite + TypeScript + Three.js (no framework)
    index.html          3D simulator page            -> src/main.ts
    tv.html             TV display page (kiosk)      -> src/tv/main.ts
    comms.html          Comms console (mock Slack, Telegram phones, POS, bus trace) -> src/comms/main.ts
    src/world/          scene, street block, storefront (with interior + campaign surfaces), rain/lighting
    src/agents/         pedestrian model, behaviour state machine, crowd spawner
    src/sensing/        storefront camera + gaze detector (AttentionDetector interface)
    src/manager/        in-browser metrics, alert rules, side panel
    src/mesh/           WebSocket client to the backend bus
    src/config.ts       all tunables: street geometry, scenarios, gaze cone, alert thresholds
  backend/              Node 20+ (run with tsx), one process
    src/index.ts        boots bus, router, adapters, POS, customers, agents  (startMesh())
    src/bus.ts          typed pub/sub + WebSocket mirror on :8787 + JSONL log
    src/llm/            provider interface, Claude (Anthropic SDK), Ollama (opt-in), template, router
    src/agents/         sensing, manager, marketing, messaging
    src/adapters/       Slack (mock | Bolt Socket Mode), Telegram (mock | grammY)
    src/security/       inbound-message sandbox
    src/pos.ts          mock point of sale
    src/customers.ts    opt-in registry (backend/data/customers.json)
    test/scenario.ts    headless end-to-end run of the whole loop (npm test)
    data/               runtime files: log.jsonl, customers.json (gitignored)
```

## Run

```sh
npm install
npm run dev:all        # frontend http://localhost:5173, backend bus ws://localhost:8787
npm test               # backend end-to-end scenario, deterministic (template brain), ~10 s
npm run typecheck      # both packages
npm run build          # frontend production bundle in frontend/dist
```

Open three tabs: Sim `/`, TV `/tv.html`, Comms `/comms.html`. Optional `.env` (see `.env.example`):
`ANTHROPIC_API_KEY` enables Claude; Slack and Telegram tokens enable real adapters; otherwise mocks.

### Demo script

1. Start `npm run dev:all`, open the three pages. Comms header shows brain (claude / template) and
   adapter mode (mock / real).
2. Sim: leave **Regular day** for about a minute (sensing needs a baseline), set speed 4×, click
   **Dinner rush**. Comms POS panel: footfall jumps, sales stay flat.
3. Manager posts a brief and an **approval card** in the Slack column. Click **Approve**.
4. TV flips to the promo with a countdown; the sim storefront shows the same headline on banner,
   window poster and A-frame; the three opted-in Telegram phones receive the text.
5. Promo-code sales appear in POS (or **Ring up sale** with the code). Manager posts the lift report.
6. Tick **Simulate offline** (or turn wifi off); brain badge becomes template. **Reset sim**, repeat.
7. On a Telegram phone click **Inject attempt**: trace shows `security.injection_blocked`, the phone
   gets a canned reply, Slack gets a security note, TV unchanged.

## How the pieces talk: the bus

`backend/src/bus.ts` is an in-process typed pub/sub. Every `publish(from, topic, payload)` creates an
`Envelope { id, ts, topic, from, traceId, payload }`, appends it to `backend/data/log.jsonl`, mirrors
it to every WebSocket client, and delivers to handlers on the next microtask (so publishers never
re-enter handlers). Browser pages use `frontend/src/mesh/meshClient.ts`, which auto-reconnects and
replays the last 200 envelopes on connect (handlers can check `isHistory(env)`).

Topics are declared once in `shared/mesh-types.ts` (`Topics` interface). Add a topic there and both
packages get the type. Current topics, in the order they usually fire:

| Topic | From → to | Meaning |
|---|---|---|
| `mesh.status` | router → pages | active provider, online flag, adapter modes |
| `customers.updated` | messaging → console | opt-in registry snapshot |
| `sim.footfall` | sim → sensing | 5 sim-second batch: passersby, lookers, walkIns, scenario |
| `sim.purchased` | sim → POS | a pedestrian bought something inside the store |
| `pos.sale` | POS → sensing, manager, console | priced sale, optional promoCode |
| `sensing.report` | sensing → manager, console | metrics window + baseline + trend + narrative |
| `manager.brief` / `comms.slack.post` | manager → Slack adapter → console | owner-facing text (kinds: brief, approval, lift, security, info) |
| `manager.opportunity` | manager → marketing | "traffic up, sales flat" with the metrics snapshot |
| `marketing.promo_draft` | marketing → manager | policy-clamped promo |
| `promo.approval_requested` | manager → (Slack) | approval card sent |
| `comms.slack.action` | console or Slack → manager | approve / reject with promoId |
| `promo.approved` / `promo.rejected` | manager → marketing | decision |
| `display.set` / `display.clear` | marketing → TV page, sim | what the TV and storefront surfaces show |
| `promo.live` / `promo.expired` | marketing → messaging, manager, POS | promo lifecycle |
| `comms.telegram.outbound` | Telegram adapter → console | message sent to a chat |
| `messaging.sent` | messaging → manager, console | broadcast summary |
| `comms.telegram.inbound` | console or Telegram → messaging | customer text (untrusted) |
| `messaging.reply` | messaging → console | canned reply chosen by code |
| `security.injection_blocked` | messaging → manager, console | sandbox verdict |
| `manager.lift_report` | manager → (Slack), console | before/after metrics and redemptions |
| `sim.control` | console → sim | switch scenario / reset |
| `mesh.control` | console → backend | force offline, ring up a sale, request status |
| `llm.call` | router → console | trace of each model call: agent, task, provider, ms, ok |

## Agent logic (what each one actually does)

All agents follow the same shape: subscribe to topics, keep private state, call the LLM router for
prose or classification, and let **code** decide what to publish. Every LLM request carries a zod
schema, an `example`, and a `template()` fallback, so an agent never stalls without a model.

**Sensing** (`agents/sensing.ts`). Keeps footfall samples and sales keyed on *sim time* (so 4× speed
still works and sim resets clear state). Every 30 sim-seconds it computes a 5-minute window and a
baseline from the prior 30 minutes (baseline counts are scaled to the window length). `trend` is
`up` if footfall/min ≥ 1.3× baseline, `down` if ≤ 0.7×. The one-sentence narrative uses the model
only when the trend changes and no call is in flight; otherwise the template.

**Manager** (`agents/manager.ts`). On each report, if no promo is live or pending and the cooldown
(10 sim-minutes) has passed: `trend === 'up'` and (window sales ≤ scaled baseline sales, or
conversion < 0.8× baseline conversion) and ≥ 20 passersby in the window → posts a brief to Slack
and publishes `manager.opportunity`. On a draft it posts an approval card. On `comms.slack.action` it
publishes `promo.approved` or `promo.rejected`. After `promo.live` it snapshots the pre-promo
metrics; on the first promo-code sale (≥ 30 sim-seconds in) it posts the lift report; if no sale
arrives in 5 sim-minutes it posts an interim report and still follows up when a sale lands. It also
relays `messaging.sent` and `security.injection_blocked` to Slack.

**Marketing** (`agents/marketing.ts`). On an opportunity it asks the model for headline, subline,
discount, duration, Telegram text, colour and rationale; code clamps discount to ≤ 20 % and duration
to 15–60 min, derives `code` (`FLASH20`), and ensures the code is in the Telegram text. On approval
it publishes `display.set` + `promo.live`, schedules `display.clear` + `promo.expired`
(`MESH_PROMO_MINUTES` overrides the duration for demos).

**Messaging** (`agents/messaging.ts`). On `promo.live` it sends the text to every opted-in customer
and publishes `messaging.sent`. Inbound text goes through the sandbox (below).

**Mock POS** (`pos.ts`). Each `sim.purchased` becomes a priced sale from a café menu (seeded RNG).
While a promo is live, 70 % of sales redeem the code and get the discount. `mesh.control ring_up`
creates a manual sale.

### Sandbox for customer text

`security/sandbox.ts`. 1) Pre-screen with regexes for instruction overrides, prompt probing, role
hijack, mass-send requests, discount steering, links and markup; a hit publishes
`security.injection_blocked` and replies with a canned message without calling the model.
2) Otherwise the text is wrapped in `<customer_message untrusted="true">` with a system prompt that
says it is data, and the model may only return `{ intent: join | stop | question | other }`.
3) Code maps the intent to opt-in, opt-out, or a fixed reply; an `other` that mentions promos or
discounts is also reported. Nothing a customer types can reach the display, approvals, or promos.

### LLM router

`llm/router.ts` picks a provider per call: Claude (`claude-opus-5-5`, structured output via
`messages.parse`) when `ANTHROPIC_API_KEY` is set and a 2 s probe of api.anthropic.com succeeds;
otherwise templates. Ollama is opt-in (`OLLAMA_ENABLED=1`, auto-picks the smallest installed model,
warms it at boot). A connection error marks the mesh offline for 30 s. `MESH_PROVIDER` pins a
provider; `MESH_FORCE_OFFLINE=1` or the console's **Simulate offline** toggle forces the fallback.
Every call is traced as `llm.call`.

## Frontend internals (the simulator)

- **World** (`src/world/`): one block of Market Street along X; near sidewalk z ∈ [−8, −2],
  storefront facade at z = −8, interior 10 m deep behind it. `Storefront` exposes `focusPoint`,
  `doorPoint`, `doorInner`, `browsePoints`, `counterPoint`, the attention zone, knobs (sign, awning,
  window display, A-frame), and `applyCampaign()` which renders text onto canvas textures for the
  banner, window poster and A-frame. `attractiveness` (0–1) and `conversionLift` feed behaviour.
- **Pedestrians** (`src/agents/`): capsule figures with a separately rotating head. State machine:
  walk → glance / stop / enter (odds = interest × attractiveness) → inside_browse → inside_counter
  (purchase) → leaving → walk. Interior movement is waypoint-driven. Separation steering only on
  the sidewalk.
- **Detection** (`src/sensing/`): `GroundTruthDetector` tests each pedestrian in the camera frustum:
  head direction within 25° of the focus point for ≥ 300 ms starts a gaze; 250 ms outside ends it.
  Emits `gaze_start/end`, `stop_and_look`, `zone_exit`; the crowd emits `entered`, `purchased`,
  `left_store`. A computer-vision detector can replace it behind `AttentionDetector`.
- **Mesh link** (`src/main.ts`): batches `zone_exit`/`entered` into `sim.footfall` every 5
  sim-seconds, forwards `purchased`, applies `display.set/clear` to the campaign surfaces, and
  obeys `sim.control`. HUD shows mesh connection and provider.
- **Scenarios** (`src/config.ts`): regular, rainy (low traffic, overcast, umbrellas), dinner rush
  (high traffic, dusk, lamps), dead hours (night). Each sets spawn rate, interest and speed
  multipliers, weather and lighting.

## Extending

- New topic: add to `Topics` in `shared/mesh-types.ts`, publish from the producer, subscribe in the
  consumer, render in `frontend/src/comms/main.ts` if it should show in the trace.
- New agent: a class taking `(bus, router, ...)`, constructed in `backend/src/index.ts`.
- New real integration: implement the adapter interface in `backend/src/adapters/`, keep the mock,
  gate on env vars in `makeX()`.
- New alert rule in the browser-only dashboard: `frontend/src/manager/alerts.ts`.
- Tunables: `frontend/src/config.ts` (sim) and the constants at the top of each backend agent.

## Verification

- `npm test` runs `backend/test/scenario.ts`: 10 sim-minutes of baseline, a surge with flat sales,
  asserts opportunity → draft (≤ 20 %) → approval card → approve → `display.set` → Telegram to 3
  opted-in customers → promo sale → lift report → injection blocked with Slack note and TV unchanged
  → JOIN opts a customer in. Deterministic with the template brain.
- The browser demo above has been driven headlessly with Playwright against the three pages.

## Not in this version

Real computer vision, Blender assets, counter queueing, payments. Slack and Telegram are mocks unless
tokens are provided. Ollama support exists but is off by default.
