# `aipster-worker runtime-plan` — preflight planner command

Integration-branch note (owns: integrator; planner: runtime lane;
launcher: integration branch). This does not change shared README pins.

## What it does

Runs the reviewed runtime setup planner (`local-worker/runtime_setup.py`)
from the installed launcher WITHOUT provisioning anything: no data-dir
creation, no token, no config write, no engine execution.

```text
aipster-worker runtime-plan --config <path-to-config.toml> [--json] [--consent yes|no]
```

- `--config` (required): operator config to evaluate. Missing file or
  malformed TOML prints a stable `config-error` (human or JSON, exit 1)
  and provisions nothing.
- `--json`: emit the structured plan instead of human text.
- `--consent yes|no` (default `no`): records install/configuration
  consent in the plan output only. The command never acts on it.
- Exits: `0` ready (preflight only), `2` setup-required, `1` config-error.

## What "ready" means (and does not)

`ready` = setup/preflight readiness only: engine observed on PATH or a
configured path, GGUF magic bytes verified, placement evidence
compatible. It is NOT executable usability (binaries are never executed),
model residency, model identity attestation, or inference qualification —
every plan carries `readiness_scope` / `not_verified` markers saying so.
The default mock config stays explicitly unqualified (`setup-required`).

## Frozen builds

`runtime_setup.py` / `runtime_discovery.py` are reached from `launcher.py`
by the same lazy-import + `pathex` pattern as the existing
`delivery_check` / `dendrite` imports, so PyInstaller static analysis
includes them with no spec change (source/spec check only; no binary
built here).
