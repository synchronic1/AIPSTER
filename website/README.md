# Public website

This directory contains the public static AiPSTER website. It preserves the approved research diagrams and presents compute sharing as work in development. No auth service, provider key, compute backend or private inventory is included.

Use Node 24, then run `npm ci --ignore-scripts`, `npm run check`, `npm test`, `npm run build` and `npm run bundle`. Package versions are pinned with a lockfile. The bundle command is a local Wrangler dry run with no upload.

Contributors and agents: choose validation from the actual diff. For an expected-SHA-only test edit with unchanged application, dependency and schema code, verify the pin against the reviewed source and run only the affected regression. A changed runtime/source pin requires the affected integration checks. Reuse results only while their relevant source, dependencies, tests and environment remain unchanged, recording the tested identity and any invalidation. Run broad integration once on the final candidate; repeat only after a material invalidating change or failure. Let necessary runs finish without duplication, and preserve required GitHub checks and security gates.

`public/` is an explicit fourteen-file source allowlist. The build copies only these files into `dist/` and adds `deployment.json` with the source commit, GitHub run URL and source-manifest hash. Only `dist/` is suitable for a future approved deployment. CI must never deploy the repository root. Original repository documentation and diagram paths outside this directory are preserved.

The PR workflow has only `contents: read` and no production secret. It performs asset/link/privacy checks, mutation-based security tests and an assets-only dry run. It does not deploy PRs.

Production deployment is not enabled by this source/checks patch. An independently reviewed deployment workflow, verified current-head Copilot review gate, main-branch rules, protected production environment and a narrowly scoped existing-Worker token must be approved and configured first. No Copilot AI-only approval, paid overage or preview deployment is implied.
