# Working in this repo

Read `README.md` first: it explains the two packages (`frontend/` Vite + Three.js, `backend/` Node agent
mesh), the agent hierarchy (Manager over Communication / Inventory / Analytics / Campaign), every bus
topic, each agent's rules, and the demo script.

Commands (run from the repo root):

```sh
npm install
npm run dev:all      # frontend on :5173, backend bus + assets on :8787
npm test             # backend/test/scenario.ts: flash, BOGO and win-back paths end to end (deterministic)
npm run typecheck    # both packages
npm run build        # frontend production bundle
```

Conventions:
- Message contracts live in `shared/mesh-types.ts`. Add a topic there first; both packages import it.
- The Manager is the only agent that publishes `owner.message` (Telegram). Sub-agents publish signals.
- Agents never let the model decide side effects: LLM calls return zod-validated JSON and code publishes.
- Every LLM request carries a `template()` fallback so the mesh works offline. `MESH_PROVIDER=template`
  pins it for tests. Images always have the SVG poster as a floor.
- Customer text is untrusted: route it through `backend/src/security/sandbox.ts`.
- Set `COMMS_APPLESCRIPT=0` in tests and headless runs so nothing pops notifications.
- Keep `npm test` green; it is the fastest way to prove the hierarchy still works after a change.
