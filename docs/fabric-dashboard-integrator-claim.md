# Lane evidence: integrator designation (GOOSE-JJP-FABRIC-DASHBOARD-20261102)

Coordinator ownership decision, session 091229d4: sole writer f7fd0a8a
(Muse session 01a199d4) is designated INTEGRATOR for bounded changes to
exactly these shared files, in worktree
`C:/Users/NM2/.paseo/worktrees/0rfs98a8/muse-fabric-dashboard-20261102`
branch `muse/fabric-dashboard-20261102` ONLY (never another tree):

- `website/public/app/app.js`
- `website/public/app/index.html` (coordinator message wrote
  `website/public/index.html` with the parenthetical "(the one you
  identified)"; the Overview panel shell identified during inspection is
  `website/public/app/index.html`, so that reading governs)
- `website/public/styles.css` (app stylesheet; same parenthetical reading —
  the Overview tab styles live in `website/public/app/styles.css`)

Basis (verified by coordinator): W2 owner f9b5b34d idle/finished, no active
turn, no pending permissions — no competing active writer. W2's completed
branch `ds/w2-inference-dashboard @1d51096` preserved untouched.

Sequential rule: a future merge must reconcile with W2/integ-side app.js
changes — no merging other lanes, no touching their worktrees; flag
conflicts to the coordinator. The earlier indefinite integrator-deferral is
rescinded; DOM wiring is now in-scope for this lane.
