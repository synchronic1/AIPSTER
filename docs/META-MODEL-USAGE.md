# Meta model usage in AIPSTER (evidence audit)

Audit base: `main` at `ba707e9` (2026-10-31). Method: repo-wide sweep for
Meta model identifiers and ML SDKs, execution-path tracing of every
llama/GGUF/inference reference (entry point → routing → invocation →
response), read-only probing of running services/processes, and an
operator-artifact inventory. This audit triggered no inference, loaded no
model, and read no credentials.

## Verdict

**No verified Meta model inference exists in AIPSTER at the audit base.**
Zero Meta model identifiers (`meta-llama`, `Llama-3/4`, `llama3`,
`Code Llama`) occur anywhere in the repository, and zero ML/Meta SDK
dependencies occur in any manifest. Every Meta-adjacent occurrence is
classified below; none is deployed/verified or locally-executed/verified
Meta inference. See [Bounded verification](#bounded-verification-procedure)
for how to check the reported usage further.

## Occurrence table

| Model/tool | User-facing function | Source @ `ba707e9` | Env | Evidence/test | Status and limitation |
|---|---|---|---|---|---|
| Website job API | None (dispatch disabled) | [worker.js:774-778](https://github.com/synchronic1/AIPSTER/blob/ba707e95efdf070bf10393f2d5fa0cef36328ba6/website/src/worker.js#L774-L778) returns 501 `INFERENCE_DISABLED` | Prod + local | `eif-guard`, `heartbeat`, `worker`, `integration-boundaries`, `eif-cpu-confinement` tests pin 501; rerun 26/26 green 2026-10-31 | Verified absent: no website path can invoke any model |
| No website→worker execute path | None | Zero references to `/execute` in `website/src` | n/a | Repo sweep 2026-10-31 | Verified absent: AIPSTER cannot dispatch to any worker |
| `LlamaRuntime` (`ik_llama`/`llama_cpp`) | Native GGUF completion via managed `llama-server` or loopback attach | [runtimes/llama.py](https://github.com/synchronic1/AIPSTER/blob/ba707e95efdf070bf10393f2d5fa0cef36328ba6/local-worker/vendor/eif/dendrite/runtimes/llama.py) (`command` L30-49, `generate` L145-184), [node.py:23](https://github.com/synchronic1/AIPSTER/blob/ba707e95efdf070bf10393f2d5fa0cef36328ba6/local-worker/vendor/eif/dendrite/node.py#L23) factory, [api.py:169-171](https://github.com/synchronic1/AIPSTER/blob/ba707e95efdf070bf10393f2d5fa0cef36328ba6/local-worker/vendor/eif/dendrite/api.py#L169-L171) `/v1/execute` | Operator machine | Fixture servers only (`test_installation.py:287-301` returns `FAKE NATIVE FIXTURE`); VERIFICATION.md: no inference used | Implemented, not execution-verified: engine adapter exists, no qualified real-model run in evidence |
| `cpu.toml` / `mock.toml` | Operator templates | [configs](https://github.com/synchronic1/AIPSTER/blob/ba707e95efdf070bf10393f2d5fa0cef36328ba6/local-worker/configs/cpu.toml) (`replace-with-your-model.gguf` placeholder) | n/a | File contents | Planned only: pins no Meta model |
| Running `:8090` worker | Mock summaries | Live `default.toml`: `mock` runtime, `mock-summary` model; [mock.py:18-24](https://github.com/synchronic1/AIPSTER/blob/ba707e95efdf070bf10393f2d5fa0cef36328ba6/local-worker/vendor/eif/dendrite/runtimes/mock.py#L18-L24) returns `[SIMULATED …]` echoes | NM2-01 loopback, observed 2026-10-31 | `GET /healthz` → `{"status":"ok"}`; BUILD.json `worker_commit 5365088` | Locally executed and verified: mock, not Meta |
| `llama-server` binary + `~/models` | Operator engine + weights | WinGet `ggml.llamacpp` package; `~/models` holds Qwen3.8-27B (Q5_K_M, Q6_K) and SmolLM2-135M (Q4_K_M) GGUFs | NM2-01, observed 2026-10-31 | Directory inventory (names/sizes only; nothing loaded) | Engine present; weights are non-Meta (Qwen, SmolLM) |
| Ollama service | None running | `ollama.exe serve` (PID observed 2026-10-31) | NM2-01 loopback | `ollama list`: DeepSeek cloud aliases only, no local weights; `ollama ps`: empty | No Meta models installed or loaded |
| Manifests | Dependency pins | `local-worker/requirements.lock`, `build-requirements.lock`, `website/package.json` | n/a | Identifier sweep: no torch/transformers/llama/vllm/ollama/openai packages | Verified absent: no Meta/ML SDK dependency |
| IK CPU qualification | One-request real-worker check | [runbook](https://github.com/synchronic1/AIPSTER/blob/ba707e95efdf070bf10393f2d5fa0cef36328ba6/docs/ik-cpu-qualification-runbook.md) (pending/blocked), [packet codec](https://github.com/synchronic1/AIPSTER/blob/ba707e95efdf070bf10393f2d5fa0cef36328ba6/website/src/inference/eif-task-contract.mjs#L1-L2) ("codec only") | n/a | `ik-cpu-packet` tests (synthetic); runbook: "no live test is claimed" | Planned only: procedure exists, gated on missing contracts |
| Fabric `llama` strings | Authorization fixtures | e.g. [fabric-f1.test.mjs:57](https://github.com/synchronic1/AIPSTER/blob/ba707e95efdf070bf10393f2d5fa0cef36328ba6/website/tests/fabric-f1.test.mjs#L57) (`models: ['llama']`) | Test | Control-plane authz tests | Test fixture: a string, not inference |
| GGUF-magic fixtures | Failure-mode assertions (missing engine, bad magic) | [qualify.py:1129](https://github.com/synchronic1/AIPSTER/blob/ba707e95efdf070bf10393f2d5fa0cef36328ba6/local-worker/packaging/windows/qualify.py#L1129) (`fixture.gguf` = `GGUF-fixture-not-a-model`), `test_installation.py:224` | Test | Installer/qualify suites assert refusal paths | Test fixture: 24 magic bytes, explicitly not a model |
| DGM preview | Fixture-table verdicts | [preview.mjs:1-11](https://github.com/synchronic1/AIPSTER/blob/ba707e95efdf070bf10393f2d5fa0cef36328ba6/website/src/dgm/preview.mjs#L1-L11) ("pure table", "does NOT run here") | Prod + local | Fixture tests | Test/mock fixture by design |
| README LoRA drill-down | Proposed architecture | [README.md:23-31](https://github.com/synchronic1/AIPSTER/blob/ba707e95efdf070bf10393f2d5fa0cef36328ba6/README.md#L23-L31) ("proposed", "not a claim of verified serving") | Docs | Prose, explicitly unverified | Documentation/planned only |
| Meta sponsor logo/link | Hackathon sponsorship display | [index.html:35](https://github.com/synchronic1/AIPSTER/blob/ba707e95efdf070bf10393f2d5fa0cef36328ba6/website/public/index.html#L35), `assets/sponsors/meta.svg`; hackathon admin links in [LICENSING.md:26-34](https://github.com/synchronic1/AIPSTER/blob/ba707e95efdf070bf10393f2d5fa0cef36328ba6/local-worker/LICENSING.md#L26-L34) | Public site + docs | Rendered chip → meta.com; rules/portal links | Display only: Meta-the-sponsor, not Meta models |
| `Built with Meta Muse.` headers | Authoring-tool attribution | Source-file header comments | n/a | Text | Documentation only: the coding assistant, not product inference |
| Unmerged catalog lane (PR #50) | Out of scope for this audit | Branch `muse/model-catalog` (OPEN at audit time) | n/a | Not reviewed here | Unaudited: this document covers `main` @ `ba707e9` only; no claim about lane branches |
| Ganglion references | Package/token names only | `worker_name: ganglion-dendrite`, `GANGLION_FABRIC_TOKEN`, fabric comments | n/a | Name sweep; fabric bridge disabled per EXECUTION-GAPS.md | No execution edge in-repo; Ganglion's own usage is that lane's audit |

## Path traces

Website submission ends before any model:

```text
POST /api/jobs -> inference authz -> 501 INFERENCE_DISABLED
  -> no job row, no adapter selection, no placement, no execution
```

Native worker path exists but is unconnected and unqualified:

```text
dendrite serve --config -> POST /v1/execute (token) -> Node.execute
  -> LlamaRuntime.ensure_loaded (spawn llama-server --model <GGUF> | attach)
  -> POST /completion {prompt, n_predict, temperature} -> content + usage
```

The model identity is purely operator configuration (default: placeholder
path). The running `:8090` instance serves `mock-summary` via `MockRuntime`.

## Bounded verification procedure

If Meta inference is believed to run somewhere this audit did not cover
(this audit covered repo `ba707e9` plus the NM2-01 local environment on
2026-10-31):

1. Name the host/process alleged to serve Meta weights. On NM2-01, no
   `llama-server`/`ik_llama-server` process was running and no Meta GGUF
   was found (`~/models`, Ollama inventory).
2. To qualify a Meta GGUF run: follow the IK CPU runbook packet
   (`modelSha256`, engine revision, RAM fit, admission receipt) with an
   attach-mode `/v1/models` identity check. Missing and required: the
   GGUF artifact under operator policy plus explicit load approval.
   This audit grants neither and loaded nothing.
3. Ganglion-lane usage, if any, needs that lane's own evidence audit;
   no AIPSTER→Ganglion execution call exists in this repository.
4. Unmerged lane branches (e.g. catalog PR #50) are outside this audit's
   base; audit each at its merge SHA before claiming anything about it.

## Reproducible receipts (2026-10-31)

- `node --test tests/eif-guard.test.mjs tests/ik-cpu-packet.test.mjs`
  → 26/26 pass on `ba707e9` (dispatch guard + packet checks).
- `ollama list` → `deepseek-v4-pro:cloud`,
  `deepseek-v4.1-flash:cloud` only; `ollama ps` → empty.
- `GET http://127.0.0.1:8090/healthz` → `{"status":"ok"}`;
  worker `default.toml` → `mock` runtime (no tokens read or printed).
