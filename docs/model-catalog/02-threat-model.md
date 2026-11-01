# Model catalog — Phase 0 threat model

<!-- Built with Meta Muse. -->

## Trust boundaries

- **Browser**: untrusted origin. Cannot supply owner fields, resource
  readings, digests, or plan contents — server re-resolves everything.
- **Hub metadata / model cards / configs**: untrusted content. Sanitized
  render, no instruction following, no code execution, no credentials.
- **Uploaded bytes**: hostile until validated. Non-executable quarantine,
  isolated parsers, no model instantiation, bounded CPU/mem/time.
- **Worker**: authenticated but independently authorizing. Control plane
  authorizes intent; worker validates scoped command + manifest + resources.
- **Catalog metadata adapter**: may read Hub, may never issue worker commands.

## Threats and controls

| # | Threat | Control | Tests |
|---|---|---|---|
| T1 | Cross-tenant private asset/job discovery (search, cache, logs, timing) | `owner_id` filter on every query; 404-not-403; principal-keyed cache; no private names in shared logs | AC02/AC10, two-identity + demo |
| T2 | SSRF via repo/download URLs, redirects to169.254/cloud metadata | Allowlisted Hub hosts (`huggingface.co`, `cdn-lfs.*.huggingface.co`); redirect cap 3, same-allowlist; private-net deny; no user-controlled worker/storage endpoints | unit + AC21 slices |
| T3 | Hub token theft/reuse across users | Session-only Phase 1, never persisted/logged/manifested; per-request user binding; no auto-accept of gated licenses | AC19, no-secret grep tests |
| T4 | Malicious card markup/JS/instructions | `esc()`-only render, no `innerHTML` of card fields, external-link marking, no prefetch/eval | AC04 |
| T5 | Path traversal / symlink / zip-slip in uploads/manifests | Server-generated keys; reject `..`, absolute, symlinks; explicit-file preference; archive bounds if ever enabled | AC11 |
| T6 | Unsafe deserialization (pickle/`bin`, `trust_remote_code`) | Block pickle-based paths + remote-code assets in support matrix; header-only parsing; isolated validator, no net | AC11/AC12 |
| T7 | Digest/revision substitution (plan→load TOCTOU) | Immutable pinned revision + full manifest in plan token; digest verify before promote; atomic promotion; recheck at load | AC12/AC15/AC20 |
| T8 | Idempotency-key misuse (replay across intents) | Keys bound to principal + canonical op fingerprint; mismatch → error, never cross-execution | AC14 |
| T9 | Quota/capacity oversubscription (parallel deploys) | Bounded node reservations before load; refresh/release protocol; reconciled-unknown-before-retry | AC15 |
| T10 | Worker impersonation / forged receipts | Heartbeat-key auth on capability endpoint; receipts validated against job state machine; unknown→reconcile, never success-by-reconnect | AC16/AC17 |
| T11 | Gated-license bypass via shared cache | Destination + acting-user access check at plan AND load; cache keyed by (asset, user-grant); no shared blob URLs for gated bytes | AC19 |
| T12 | UI job loss/duplication on navigation | Server-owned jobs; idempotency keys in UI retry; no cancel on tab close; reconnect reconciles by job ID | AC22/AC17 |
| T13 | Demo sandbox escape (uploads/deploys/keys) | Demo denied all non-read catalog ops server-side; demo sees fixtures only | demo slices |
| T14 | Unbounded resource use (transfers/validations/jobs) | Per-file/total/account quotas, chunk bounds, validator CPU/mem/time caps, job concurrency caps | AC11/AC13 |

## Non-goals (explicitly not defended here)

- Malicious-but-valid model weights producing bad outputs (quality/safety of
  model behavior is out of scope; integrity + provenance only).
- Compromised worker host exfiltrating bytes it legitimately received
  (disclosed to user for shared nodes; operator trust is explicit).
- Hub-side compromise (pinned digests bound the blast radius to disclosed bytes).
