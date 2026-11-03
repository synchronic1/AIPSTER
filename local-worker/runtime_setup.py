"""Consent-guided setup planner for the AIPSTER worker runtime.

Reads an operator-owned config, combines it with observe-only discovery
(:mod:`runtime_discovery`), and prints explicit human-readable and
structured (``--json``) actions. The planner NEVER installs, downloads,
configures, starts, or enrolls anything: every action is an operator step
gated on explicit consent, and consent is only ever recorded, never acted
on here.

Exit codes: 0 ready, 2 setup-required, 1 config-error/usage.
"""

import argparse
import json
import shutil
import sys
import tomllib
from pathlib import Path
from types import SimpleNamespace

from runtime_discovery import (
    MOCK_KIND,
    REAL_KINDS,
    assess_placement,
    discover_engines,
    summarize_config_models,
)

SETUP_REQUIRED = "setup-required"
READY = "ready"
CONFIG_ERROR = "config-error"

# A "ready" plan is setup/preflight readiness ONLY: engine path observed
# (PATH lookup or a configured explicit path), GGUF magic bytes verified,
# config references valid, placement evidence compatible. It is NOT tested
# executable usability (discovered binaries are never executed), model
# residency, model identity attestation, or inference qualification —
# those remain unqualified/not-run and are marked as such on every plan.
READINESS_SCOPE = (
    "setup/preflight readiness only: engine observed (PATH or configured "
    "path), GGUF magic bytes verified, config references valid, placement "
    "evidence compatible")
NOT_VERIFIED = (
    "tested executable usability (binaries are never executed)",
    "model residency",
    "model identity attestation",
    "inference qualification")

FALLBACK_GUIDANCE = (
    "Supported configurations: native ik_llama managed runtime with a "
    "real GGUF model file (set the [[models]] path yourself), or "
    "llama_cpp managed with a real GGUF / attach with an "
    "upstream_model on a loopback server you run yourself. The mock "
    "runtime is a test/demo option only and never counts as "
    "operational. To select: edit config.toml yourself; this worker "
    "never downloads models, starts runtimes, copies credentials, "
    "or changes enrollment automatically."
)

MOCK_DEMO_ENV = "AIPSTER_WORKER_MOCK_DEMO"


def _vendored_config_loader():
    """Return the vendored ``load_config`` or None (adapter boundary).

    The vendored module needs third-party deps; when they are absent the
    planner falls back to a stdlib TOML reader and says so in the plan.
    """
    try:
        from dendrite.config import load_config

        return load_config
    except ImportError:
        return None


def _fallback_load_config(path):
    """Minimal stdlib config reader mirroring the vendored path resolution.

    Raises OSError for a missing/unreadable file and ValueError for
    malformed TOML or an empty runtimes/models selection. Semantic
    problems (unknown runtime refs, missing model paths) are NOT errors
    here: the planner reports them as unqualified states.
    """
    raw = tomllib.loads(Path(path).read_text(encoding="utf-8"))
    parent = Path(path).resolve().parent

    def resolve(value):
        return str((parent / value).resolve())

    runtimes = []
    for entry in raw.get("runtimes", []):
        item = dict(entry)
        if "/" in str(item.get("executable", "")):
            item["executable"] = resolve(item["executable"])
        runtimes.append(SimpleNamespace(
            id=item.get("id"),
            kind=item.get("kind"),
            mode=item.get("mode", "managed"),
            executable=item.get("executable", "llama-server"),
            port=item.get("port", 8081),
            base_url=item.get("base_url"),
            threads=item.get("threads", 4),
            gpu_layers=item.get("gpu_layers", 0),
        ))
    models = []
    for entry in raw.get("models", []):
        item = dict(entry)
        models.append(SimpleNamespace(
            id=item.get("id"),
            runtime=item.get("runtime"),
            capabilities=list(item.get("capabilities", [])),
            path=resolve(item["path"]) if item.get("path") else None,
            upstream_model=item.get("upstream_model"),
        ))
    if not runtimes or not models:
        raise ValueError("no runtimes/models are configured")
    return SimpleNamespace(runtimes=runtimes, models=models)


def load_config_adapter(path):
    """Load config via vendored logic when available, else stdlib fallback.

    Returns ``(source, config)`` with source ``"vendored"``/``"fallback"``,
    or ``("error", message)`` for missing/malformed files (never raises).
    """
    loader = _vendored_config_loader()
    if loader is not None:
        try:
            return "vendored", loader(Path(path))
        except Exception as exc:
            return "error", f"{type(exc).__name__}: {exc}"
    try:
        return "fallback", _fallback_load_config(path)
    except (OSError, ValueError) as exc:
        return "error", f"{type(exc).__name__}: {exc}"


def _fallback_classify(loaded):
    """Classifier mirroring the firstrun vocabulary (adapter fallback)."""
    try:
        runtimes = list(getattr(loaded, "runtimes", None) or [])
        models = list(getattr(loaded, "models", None) or [])
    except TypeError:
        runtimes, models = [], []
    if not runtimes or not models:
        return {"status": SETUP_REQUIRED, "mock_only": False,
                "reason": "no runtimes/models are configured",
                "guidance": FALLBACK_GUIDANCE}
    by_id = {getattr(r, "id", None): r for r in runtimes}
    if all(getattr(r, "kind", None) == MOCK_KIND for r in runtimes):
        return {"status": SETUP_REQUIRED, "mock_only": True,
                "reason": ("mock runtime is a test/demo option only; "
                           "select a real configured runtime to operate"),
                "guidance": FALLBACK_GUIDANCE}
    for model in models:
        runtime = by_id.get(getattr(model, "runtime", None))
        if runtime is None:
            continue
        if getattr(runtime, "kind", None) not in REAL_KINDS:
            continue
        if getattr(runtime, "mode", "managed") == "attach":
            if getattr(model, "upstream_model", None):
                return {"status": READY, "mock_only": False,
                        "reason": "attached runtime is configured",
                        "guidance": FALLBACK_GUIDANCE}
            continue
        if getattr(model, "path", None):
            return {"status": READY, "mock_only": False,
                    "reason": "managed runtime has a configured model path",
                    "guidance": FALLBACK_GUIDANCE}
    return {"status": SETUP_REQUIRED, "mock_only": False,
            "reason": "no real model is configured",
            "guidance": FALLBACK_GUIDANCE}


def classify_adapter(loaded):
    """Classify via firstrun when importable, else the local fallback.

    Returns ``(classifier, result)``; never raises (unreadable input is
    setup-required, matching firstrun's own never-raises contract).
    """
    try:
        packaging_dir = Path(__file__).resolve().parent / "packaging"
        if str(packaging_dir) not in sys.path:
            sys.path.insert(0, str(packaging_dir))
        from aipster_tray.firstrun import (  # noqa: E402
            classify_runtime_selection,
            supported_configuration_guidance,
        )

        try:
            result = classify_runtime_selection(loaded)
            result = dict(result)
            result.setdefault("guidance", supported_configuration_guidance())
            return "firstrun", result
        except Exception:
            pass
    except ImportError:
        pass
    return "fallback", _fallback_classify(loaded)


def _observe_hardware(hardware, hardware_probe):
    """Use injected hardware, an injected probe, or vendored discovery."""
    if hardware is not None:
        return hardware
    if hardware_probe is not None:
        try:
            return hardware_probe()
        except Exception:
            return None
    try:
        from dendrite.hardware import discover_hardware

        try:
            return discover_hardware()
        except Exception:
            return None
    except ImportError:
        return None


def _executable_observed(executable, which):
    """Check an executable name via PATH or an explicit path via the disk."""
    if not executable:
        return False
    if "/" in executable or "\\" in executable:
        try:
            return Path(executable).is_file()
        except (OSError, ValueError):
            return False
    try:
        return bool((which or shutil.which)(executable))
    except Exception:
        return False


def plan_setup(config_path, *, consent=False, which=None,
               hardware=None, hardware_probe=None, gguf_check=None):
    """Build the setup plan for ``config_path`` (pure planning, no effects).

    ``consent`` records the operator's install/configuration consent
    (default denied); it is reported, never acted on.
    """
    source, loaded = load_config_adapter(config_path)
    if source == "error":
        return {
            "status": CONFIG_ERROR,
            "config_source": source,
            "classifier": "none (config unreadable)",
            "reason": loaded,
            "readiness_scope": READINESS_SCOPE,
            "not_verified": list(NOT_VERIFIED),
            "actions": [
                f"Fix {config_path} ({loaded}), then re-run this planner.",
                "Nothing was installed, configured, or started.",
            ],
            "consent": {"required": False, "granted": False,
                        "preview": "No consent applies: the config could not be read."},
        }

    classifier, verdict = classify_adapter(loaded)
    engines = discover_engines(which=which)
    observed_exe = {e.name: e for e in engines}
    models = summarize_config_models(loaded, gguf_check=gguf_check)
    hw = _observe_hardware(hardware, hardware_probe)
    placement = assess_placement(loaded, hw)

    unqualified = []
    evidence = []
    runtimes = {getattr(r, "id", None): r for r in (getattr(loaded, "runtimes", []) or [])}
    place_by_model = {(p.runtime_id, p.model_id): p for p in placement}

    for obs in models:
        runtime = runtimes.get(obs.runtime_id)
        kind = getattr(runtime, "kind", None) if runtime is not None else None
        mode = getattr(runtime, "mode", "managed") if runtime is not None else "managed"
        place = place_by_model.get((obs.runtime_id, obs.model_id))
        if kind == MOCK_KIND or kind not in REAL_KINDS:
            evidence.append(f"model {obs.model_id!r}: mock/unknown runtime; test/demo only")
            continue
        if mode == "attach":
            model_obj = next((m for m in (getattr(loaded, "models", []) or [])
                              if getattr(m, "id", None) == obs.model_id), None)
            if model_obj is not None and getattr(model_obj, "upstream_model", None):
                evidence.append(
                    f"model {obs.model_id!r}: attach configured "
                    f"(upstream_model set; server liveness not probed by this planner)")
            else:
                unqualified.append(
                    f"model {obs.model_id!r}: attach mode needs upstream_model identity")
            continue
        exe = getattr(runtime, "executable", "llama-server")
        if not _executable_observed(exe, which):
            unqualified.append(
                f"model {obs.model_id!r}: engine {exe!r} not found; "
                "install it yourself, then re-run this planner")
        elif obs.gguf == "gguf":
            if place is not None and not place.compatible:
                unqualified.append(
                    f"model {obs.model_id!r}: " + "; ".join(place.notes))
            else:
                evidence.append(
                    f"model {obs.model_id!r}: engine observed, GGUF magic verified, "
                    "placement compatible")
        elif obs.gguf == "not-gguf":
            unqualified.append(
                f"model {obs.model_id!r}: {obs.path_str} is not a GGUF file "
                "(magic bytes mismatch); point the model path at a real GGUF")
        elif obs.gguf == "unreadable":
            unqualified.append(
                f"model {obs.model_id!r}: {obs.path_str} cannot be read; "
                "check the path and file permissions")
        else:
            unqualified.append(
                f"model {obs.model_id!r}: no model file configured; "
                "place a GGUF file yourself (never downloaded automatically) "
                "and set the [[models]] path in config.toml")
        if place is not None:
            for note in place.notes:
                if "advisory" in note and not any(note in e for e in evidence):
                    evidence.append(f"model {obs.model_id!r} advisory: {note}")

    mock_only = bool(verdict.get("mock_only"))
    if mock_only:
        status = SETUP_REQUIRED
        reason = verdict.get("reason", "mock runtime is a test/demo option only")
    elif unqualified:
        status = SETUP_REQUIRED
        reason = unqualified[0]
    elif verdict.get("status") == READY and evidence:
        status = READY
        reason = verdict.get("reason", "a real configured runtime is selected")
    elif verdict.get("status") == READY:
        # Classifier is satisfied but this planner found no verified
        # evidence (measured beats observed): stay setup-required.
        status = SETUP_REQUIRED
        reason = ("configuration looks selected but no engine+GGUF evidence "
                  "was verified; " + verdict.get("reason", ""))
    else:
        status = SETUP_REQUIRED
        reason = verdict.get("reason", "no real model is configured")

    actions = []
    if status == READY:
        actions.append(
            "Configuration is ready for setup/preflight purposes only "
            "(see readiness scope below; executable usability, residency, "
            "identity attestation and inference qualification were NOT run): "
            "start the worker yourself when you choose.")
    else:
        actions.extend(unqualified or [reason])
        if mock_only:
            actions.append(
                f"For test/demo only, explicitly elect the mock engine with "
                f"{MOCK_DEMO_ENV}=1 (never operational, never silent).")
        actions.append("To operate: edit config.toml yourself; then re-run this planner.")
    actions.append("This planner never downloads, installs, starts, or enrolls anything.")

    observed_names = sorted(e.name for e in engines if e.observed)
    consent_required = status == SETUP_REQUIRED
    if consent_required:
        preview = ("With your explicit consent, a later guided step may: install the "
                   "missing engine binary, place configuration, or point the config "
                   "at a model file. Consent is recorded here only; this planner "
                   "takes no such action.")
    else:
        preview = "No install/configuration consent applies."
    return {
        "status": status,
        "config_source": source,
        "classifier": classifier,
        "mock_only": mock_only,
        "reason": reason,
        "readiness_scope": READINESS_SCOPE,
        "not_verified": list(NOT_VERIFIED),
        "guidance": verdict.get("guidance", FALLBACK_GUIDANCE),
        "engines_observed": observed_names,
        "hardware_observed": hw is not None,
        "evidence": evidence,
        "unqualified": unqualified,
        "actions": actions,
        "consent": {"required": consent_required,
                    "granted": bool(consent) and consent_required,
                    "preview": preview},
    }


def format_human(plan, config_path):
    lines = [
        f"config: {config_path} (source: {plan.get('config_source', 'unknown')}, "
        f"classifier: {plan.get('classifier', 'none')})",
        f"status: {plan.get('status', CONFIG_ERROR)}",
        f"reason: {plan.get('reason', 'unavailable')}",
        f"readiness scope: {plan.get('readiness_scope', READINESS_SCOPE)}",
        "not verified (not run): "
        + "; ".join(plan.get("not_verified", list(NOT_VERIFIED))),
    ]
    if plan.get("evidence"):
        lines.append("verified evidence:")
        lines.extend(f"  - {item}" for item in plan["evidence"])
    if plan.get("unqualified"):
        lines.append("unqualified:")
        lines.extend(f"  - {item}" for item in plan["unqualified"])
    lines.append("actions:")
    lines.extend(f"  {i}. {item}" for i, item in enumerate(plan["actions"], 1))
    consent = plan["consent"]
    lines.append(f"consent required: {consent['required']}; granted: {consent['granted']}")
    lines.append(f"consent preview: {consent['preview']}")
    return "\n".join(lines)


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="Plan worker runtime setup (observe + advise only; makes no changes).")
    parser.add_argument("--config", required=True, help="operator config.toml to evaluate")
    parser.add_argument("--json", action="store_true", help="emit the structured plan as JSON")
    parser.add_argument("--consent", choices=("yes", "no"), default="no",
                        help="record explicit install/configuration consent (default: no). "
                             "Recorded only; this planner never acts on it.")
    args = parser.parse_args(argv)
    plan = plan_setup(args.config, consent=(args.consent == "yes"))
    if args.json:
        print(json.dumps(plan, indent=2))
    else:
        print(format_human(plan, args.config))
    status = plan.get("status", CONFIG_ERROR)
    if status == READY:
        return 0
    return 1 if status == CONFIG_ERROR else 2


if __name__ == "__main__":
    raise SystemExit(main())
