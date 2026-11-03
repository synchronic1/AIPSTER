"""Observe-only runtime discovery for the AIPSTER worker setup planner.

Distinguishes OBSERVED (a binary is on PATH, a file has GGUF magic) from
SELECTABLE/QUALIFIED (an operator-owned config explicitly points at them
and they satisfy the suitability evidence below). Observing a generic
``llama-server``/``ik_llama-server`` — or ``ollama`` — on PATH never
implies a working selectable runtime: ``ollama`` is recorded but is never
a selectable kind, matching the vendored config contract.

No installs, no binary execution, no model loading, no disk-wide scan:
only PATH lookup plus operator-specified paths. All probes are injectable
so the planner and its tests stay deterministic and offline.
"""

import shutil
from dataclasses import dataclass, field

GGUF_MAGIC = b"GGUF"

# Engine binary names the vendored hardware discovery observes.
KNOWN_MANAGED_ENGINES = ("llama-server", "ik_llama-server")
# Observed on PATH but never a selectable runtime kind.
OBSERVED_NEVER_SELECTABLE = ("ollama",)
# Runtime kinds the vendored config contract accepts as real (non-mock).
REAL_KINDS = ("ik_llama", "llama_cpp")
MOCK_KIND = "mock"


@dataclass
class EngineObservation:
    name: str
    path: str | None
    observed: bool
    selectable: bool
    note: str = ""


@dataclass
class ModelObservation:
    model_id: str
    runtime_id: str | None
    kind: str | None
    mode: str
    path_str: str | None = None
    exists: bool = False
    # 'gguf' | 'not-gguf' | 'unreadable' | 'absent' | 'not-applicable-attach'
    gguf: str = "absent"
    size_bytes: int | None = None


@dataclass
class PlacementAssessment:
    runtime_id: str
    model_id: str
    # False only on incompatible placement (e.g. GPU layers, no GPU).
    compatible: bool
    notes: list = field(default_factory=list)


def discover_engines(which=None):
    """Record known engine binaries without executing anything.

    ``which`` defaults to :func:`shutil.which` and may be injected.
    """
    probe = which or shutil.which
    observations = []
    for name in KNOWN_MANAGED_ENGINES:
        try:
            found = probe(name)
        except Exception:
            found = None
        observations.append(EngineObservation(
            name=name,
            path=str(found) if found else None,
            observed=bool(found),
            selectable=bool(found),
            note="" if found else "not on PATH; install it yourself, then select it in config.toml",
        ))
    for name in OBSERVED_NEVER_SELECTABLE:
        try:
            found = probe(name)
        except Exception:
            found = None
        observations.append(EngineObservation(
            name=name,
            path=str(found) if found else None,
            observed=bool(found),
            selectable=False,
            note="observed only; ollama is never a selectable runtime kind",
        ))
    return observations


def check_gguf_magic(path, opener=None):
    """Return 'gguf' / 'not-gguf' / 'unreadable' without loading the model.

    ``opener`` may be injected as ``fn(path) -> bytes`` (first 4 bytes).
    """
    try:
        if opener is not None:
            head = opener(path)
        else:
            with open(path, "rb") as handle:
                head = handle.read(4)
    except (OSError, ValueError):
        return "unreadable"
    except Exception:
        return "unreadable"
    return "gguf" if head == GGUF_MAGIC else "not-gguf"


def summarize_config_models(config, gguf_check=None):
    """Describe each configured model's on-disk evidence (duck-typed config).

    Accepts the vendored dendrite ``Config`` or any fixture exposing
    ``.runtimes`` (``.id``/``.kind``, optional ``.mode``) and ``.models``
    (``.id``/``.runtime``, optional ``.path``). Attach models carry no
    local path: their GGUF state is ``not-applicable-attach``.
    """
    check = gguf_check or check_gguf_magic
    try:
        runtimes = list(getattr(config, "runtimes", None) or [])
        models = list(getattr(config, "models", None) or [])
    except TypeError:
        return []
    by_id = {getattr(r, "id", None): r for r in runtimes}
    observations = []
    for model in models:
        runtime = by_id.get(getattr(model, "runtime", None))
        kind = getattr(runtime, "kind", None) if runtime is not None else None
        mode = getattr(runtime, "mode", "managed") if runtime is not None else "managed"
        path = getattr(model, "path", None)
        obs = ModelObservation(
            model_id=str(getattr(model, "id", "?")),
            runtime_id=getattr(model, "runtime", None),
            kind=kind,
            mode=mode or "managed",
        )
        if mode == "attach" or runtime is None:
            obs.gguf = "not-applicable-attach"
            obs.path_str = None if path is None else str(path)
            observations.append(obs)
            continue
        if path is None:
            observations.append(obs)
            continue
        obs.path_str = str(path)
        try:
            import os

            st = os.stat(path)
            obs.exists = True
            obs.size_bytes = st.st_size
        except (OSError, ValueError):
            observations.append(obs)
            continue
        try:
            from pathlib import Path as _Path

            if not _Path(path).is_file():
                obs.gguf = "unreadable"
                observations.append(obs)
                continue
        except (OSError, ValueError):
            obs.gguf = "unreadable"
            observations.append(obs)
            continue
        obs.gguf = check(path)
        observations.append(obs)
    return observations


def assess_placement(config, hardware):
    """Check CPU/GPU suitability evidence per configured model.

    ``hardware`` is a vendored ``discover_hardware()`` dict (or a fixture
    with the same keys) or None when hardware could not be observed.
    Fail-closed: a GPU request without observed hardware/GPU evidence is
    incompatible; thread/memory mismatches are advisories only. Mock
    runtimes are never suitable capacity and are reported, not assessed.
    """
    try:
        runtimes = list(getattr(config, "runtimes", None) or [])
        models = list(getattr(config, "models", None) or [])
    except TypeError:
        return []
    by_id = {getattr(r, "id", None): r for r in runtimes}
    assessments = []
    for model in models:
        runtime = by_id.get(getattr(model, "runtime", None))
        if runtime is None:
            continue
        if getattr(runtime, "kind", None) == MOCK_KIND:
            assessments.append(PlacementAssessment(
                runtime_id=getattr(runtime, "id", "?"),
                model_id=str(getattr(model, "id", "?")),
                compatible=False,
                notes=["mock runtime is a test/demo option only; never operational capacity"],
            ))
            continue
        notes = []
        compatible = True
        layers = getattr(runtime, "gpu_layers", 0) or 0
        if hardware is None:
            if layers > 0:
                compatible = False
                notes.append(
                    "gpu_layers > 0 but hardware was not observed; "
                    "GPU presence cannot be verified (fail-closed)"
                )
            else:
                notes.append("hardware unobserved; CPU-only placement assumed unverified")
        else:
            gpus = hardware.get("gpus") or []
            if layers > 0 and not gpus:
                compatible = False
                notes.append(
                    "gpu_layers > 0 but no GPU was discovered; "
                    "set gpu_layers = 0 for CPU-only or use a GPU host"
                )
            threads = getattr(runtime, "threads", None) or 0
            logical = hardware.get("logical_cpus")
            if logical and threads > logical:
                notes.append(
                    f"threads ({threads}) exceeds observed logical CPUs ({logical}); "
                    "advisory only, not blocking"
                )
        assessments.append(PlacementAssessment(
            runtime_id=str(getattr(runtime, "id", "?")),
            model_id=str(getattr(model, "id", "?")),
            compatible=compatible,
            notes=notes,
        ))
    return assessments
