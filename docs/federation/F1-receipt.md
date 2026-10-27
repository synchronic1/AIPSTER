# F1 stage receipt

- SHA: `<filled at commit>` (branch
  `muse/federation-control-plane`, base F0 `4abdb81`; PR #3 branch untouched).
- Files: `website/migrations/0005_fabric.sql`,
  `website/src/fabric/store.mjs` (new, 32 exports),
  `website/src/fabric/router.mjs` (new, REST + MCP),
  `website/src/worker.js` (mount + `/v1/fabric/` route prefix),
  `website/public/app/index.html` + `website/public/app/app.js` (Federation
  tab, resetState coverage), `website/tests/d1-shim.mjs` (0005 in suite
  migrations), `website/tests/fabric-f1.test.mjs` (new, 21 tests).
- Commands/results: `npm test` 167/167; `npm run check` pass (18 files);
  `npm run build` green. workerd smoke on :8899 with
  `FEDERATION_ENABLED=1`: anon `/v1/fabric/nodes` -> 401 AUTH_REQUIRED,
  anon `/v1/fabric/mcp` -> 401, `/api/health` ready:true; server stopped
  after. Other agent's :8787 listener left alone. Scratch walkthrough
  `/tmp/fabric-walk.mjs` (23 checks) passed; not committed.
- Proposed vs enforced: invitation -> acceptance -> connection -> preview ->
  approval -> commit -> enforce/pause/resume/revoke, denies, authorization
  previews, discovery, idempotent mutations, and MCP parity are enforced by
  21 server tests running the real worker handler. UI Federation tab is
  wired with resetState clearing (static coverage test; no live browser
  pass). Flag defaults off; fixture route/transport only; no execution, no
  network peers, no quota spending (ceilings recorded, enforced at
  admission preview only in F1P scope).
- Independent review: unavailable in-session; requested via pushed branch
  (reviewer: Goose). Not claimed.
- Unresolved risks: no browser-driven UI pass yet; MCP is a JSON tool
  envelope, not full JSON-RPC/schema negotiation; D1 concurrent-accept
  relies on single-statement conditional UPDATE (documented F0 design);
  stored key `delegate` claims parsed but no issuance path sets them in F1.
- Next prerequisites: none for F1P (authorized). F1P needs no new approvals.
