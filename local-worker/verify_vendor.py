"""Verify the explicit public-source allowlist and recorded local patches.

Unpatched files must match the pinned upstream bytes. A patched file must match its
recorded patched hash, and `--check-patches` proves that reversing the recorded patch
reproduces the upstream hash. `--restore-from` rebuilds the tree from the exact commit
and reapplies the recorded patches.
"""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parent


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def apply_patches(files, patches, reverse=False):
    """Apply recorded patches to {path: bytes} in a temporary directory, returning new bytes.

    Inside a repository subdirectory `git apply` silently skips paths it considers outside
    that directory, so patches are only ever applied in an isolated temporary tree.
    """
    with tempfile.TemporaryDirectory(prefix="aipster-vendor-patch-") as temp:
        for path, data in files.items():
            (Path(temp) / path).parent.mkdir(parents=True, exist_ok=True)
            (Path(temp) / path).write_bytes(data)
        for patch in (reversed(patches) if reverse else patches):
            subprocess.run(["git", "-c", "core.autocrlf=false", "apply", "--whitespace=nowarn",
                            *(["-R"] if reverse else []), str(ROOT / patch["path"])],
                           cwd=temp, check=True)
        return {path: (Path(temp) / path).read_bytes() for path in files}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--restore-from", type=Path)
    parser.add_argument("--check-patches", action="store_true")
    args = parser.parse_args()
    manifest = json.loads((ROOT / "provenance.json").read_text())
    vendor = ROOT / "vendor/eif"
    patches = manifest.get("local_patches", [])
    for patch in patches:
        if sha256((ROOT / patch["path"]).read_bytes()) != patch["sha256"]:
            raise SystemExit("Hash mismatch: " + patch["path"])
        if patch["applies_to_commit"] != manifest["commit"]:
            raise SystemExit("Patch base differs from pinned commit: " + patch["path"])
    patched = {path for patch in patches for path in patch["files"]}
    if not patched <= {item["path"] for item in manifest["files"]}:
        raise SystemExit("Patch names a file outside the allowlist: " + str(sorted(patched)))
    upstream = {}
    for item in manifest["files"]:
        path = item["path"]
        if (path in patched) != ("upstream_sha256" in item):
            raise SystemExit("Patch record inconsistent for " + path)
        target = vendor / path
        if not target.resolve().is_relative_to(vendor.resolve()):
            raise SystemExit("Path outside vendor directory")
        if args.restore_from:
            data = subprocess.check_output([
                "git", "-C", str(args.restore_from), "show", manifest["commit"] + ":" + path
            ])
            if sha256(data) != item.get("upstream_sha256", item["sha256"]):
                raise SystemExit("Upstream hash mismatch: " + path)
            upstream[path] = data
    if args.restore_from:
        restored = upstream | apply_patches({p: upstream[p] for p in patched}, patches)
        expected = {item["path"]: item["sha256"] for item in manifest["files"]}
        for path, data in restored.items():
            if sha256(data) != expected[path]:
                raise SystemExit("Restored bytes do not match the recorded hash; nothing written: " + path)
        for path, data in restored.items():
            (vendor / path).parent.mkdir(parents=True, exist_ok=True)
            (vendor / path).write_bytes(data)
    if args.check_patches:
        reverted = apply_patches({p: (vendor / p).read_bytes() for p in patched}, patches, reverse=True)
        for item in manifest["files"]:
            if item["path"] in patched and sha256(reverted[item["path"]]) != item["upstream_sha256"]:
                raise SystemExit("Reversed patch does not reproduce upstream: " + item["path"])
    for item in manifest["files"]:
        if sha256((vendor / item["path"]).read_bytes()) != item["sha256"]:
            raise SystemExit("Hash mismatch: " + item["path"])
    allowed = {item["path"] for item in manifest["files"]} | {"LICENSE", "NOTICE"}
    actual = {p.relative_to(vendor).as_posix() for p in vendor.rglob("*") if p.is_file()}
    if actual != allowed:
        raise SystemExit("Unexpected/missing vendor files: " + str(sorted(actual ^ allowed)))
    print(f"Verified {len(manifest['files'])} files against {manifest['commit']}: "
          f"{len(manifest['files']) - len(patched)} upstream-identical, {len(patched)} locally patched"
          + (" (patches reverse to upstream)" if args.check_patches else ""))


if __name__ == "__main__":
    main()
