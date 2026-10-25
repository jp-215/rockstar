# Working in this repo

Read `README.md` first: it explains the two packages (`frontend/` Vite + Three.js, `backend/` Node agent
mesh), every bus topic, each agent's rule, and the demo script.

Commands (run from the repo root):

```sh
npm install
npm run dev:all      # frontend on :5173, backend bus on ws://localhost:8787
npm test             # backend/test/scenario.ts: headless end-to-end run of the whole loop (deterministic)
npm run typecheck    # both packages
npm run build        # frontend production bundle
```

Conventions:
- Message contracts live in `shared/mesh-types.ts`. Add a topic there first; both packages import it.
- Agents never let the model decide side effects: LLM calls return zod-validated JSON and code publishes.
- Every LLM request carries a `template()` fallback so the mesh works offline. `MESH_PROVIDER=template`
  pins it for tests.
- Customer text (Telegram) is untrusted: route it through `backend/src/security/sandbox.ts`.
- Keep `npm test` green; it is the fastest way to prove the loop still works after a change.
