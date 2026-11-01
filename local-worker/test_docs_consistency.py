"""Docs must agree with the vendored tree that ships next to them.

These are offline, stdlib-only checks. They were written failing-first against
`9c2c479` (docs carried over from `main` without the reviewed patch-0002
documentation) and pass on the repaired tree. Nothing here inspects a runtime,
a model, a credential or a network endpoint.
"""

import json
import pathlib
import re

HERE = pathlib.Path(__file__).resolve().parent

_NUMBER_WORDS = {
    "zero": 0, "one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6,
    "seven": 7, "eight": 8, "nine": 9, "ten": 10, "eleven": 11, "twelve": 12,
    "thirteen": 13, "fourteen": 14, "fifteen": 15, "sixteen": 16,
}


def _read(name):
    return (HERE / name).read_text(encoding="utf-8")


def _provenance():
    return json.loads(_read("provenance.json"))


def _patched_files(provenance):
    return [entry for entry in provenance["files"] if entry.get("local_patch")]


def _claimed_count(text, pattern):
    match = re.search(pattern, text)
    assert match, f"docs lost their upstream-identical file count: {pattern!r}"
    word = match.group(1).lower()
    return _NUMBER_WORDS[word] if word in _NUMBER_WORDS else int(word)


def _expected_upstream_identical(provenance):
    return len(provenance["files"]) - len(_patched_files(provenance))


def test_licensing_change_notices_match_provenance():
    """LICENSING.md is the Apache-2.0 4(b) change-notice summary; it must name
    every recorded local patch and every patched file, and must not claim a
    stale pre-patch count of upstream-identical files."""
    provenance = _provenance()
    text = _read("LICENSING.md")
    patched = _patched_files(provenance)

    assert patched, "provenance records no locally patched files"
    for patch in provenance["local_patches"]:
        assert re.search(rf"patch {patch['id']}\b", text), (
            f"LICENSING.md never names local patch {patch['id']}"
        )
    for entry in patched:
        assert entry["path"] in text, (
            f"LICENSING.md never names patched file {entry['path']}"
        )

    claimed = _claimed_count(text, r"\b([A-Za-z]+) files keep their original bytes")
    expected = _expected_upstream_identical(provenance)
    assert claimed == expected, (
        f"LICENSING.md claims {claimed} upstream-identical files; "
        f"provenance implies {expected}"
    )


def test_readme_provenance_names_every_local_patch():
    """README.md's provenance summary must match the same allowlist."""
    provenance = _provenance()
    text = _read("README.md")

    claimed = _claimed_count(text, r"\b([A-Za-z]+)\s+files\s+are byte-for-byte upstream")
    expected = _expected_upstream_identical(provenance)
    assert claimed == expected, (
        f"README.md claims {claimed} upstream-identical files; "
        f"provenance implies {expected}"
    )
    for patch in provenance["local_patches"]:
        assert re.search(rf"patch\s*\[?{patch['id']}", text, re.IGNORECASE), (
            f"README.md never names local patch {patch['id']}"
        )
    for entry in _patched_files(provenance):
        assert entry["path"] in text, (
            f"README.md never names patched file {entry['path']}"
        )


def test_execution_gaps_documents_the_reviewed_fabric_contract():
    """EXECUTION-GAPS.md must describe what patch 0002 actually does and record
    the fabric contract limits the worker cannot invent fields for."""
    text = _read("EXECUTION-GAPS.md")

    assert "only to satisfy package imports" not in text, (
        "EXECUTION-GAPS.md still calls the reviewed fabric bridge a legacy import stub"
    )
    assert "patch 0002" in text.lower(), (
        "EXECUTION-GAPS.md does not describe local patch 0002"
    )
    for phrase in ("no cancel frame", "no deadline field", "resident-only"):
        assert phrase in text.lower(), (
            f"EXECUTION-GAPS.md does not record the fabric limit: {phrase!r}"
        )
    assert "cross-reconnect" in text.lower(), (
        "EXECUTION-GAPS.md does not record the missing durable execution ledger"
    )


def test_readme_documents_the_opt_in_fabric_connection():
    """README.md must document the opt-in node connection, including the
    resident-only policy, so operators do not infer it is an AIPSTER transport."""
    text = _read("README.md")

    assert "## Opt-in Ganglion fabric node connection" in text
    assert "fabric_url" in text
    lowered = text.lower()
    assert "resident-only" in lowered or "resident only" in lowered
    assert "not an aipster" in lowered, (
        "README.md does not separate the fabric control plane from AIPSTER dispatch"
    )


def test_verification_records_fabric_evidence():
    """VERIFICATION.md must carry the patch-0002 evidence and its limits."""
    text = _read("VERIFICATION.md")

    assert "patch 0002" in text.lower()
    assert "test_fabric_bridge" in text
    assert "fake fabric" in text.lower() or "fake-fabric" in text.lower(), (
        "VERIFICATION.md does not state that the fabric evidence is synthetic"
    )
