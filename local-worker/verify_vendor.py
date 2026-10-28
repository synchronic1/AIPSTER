"""Verify the explicit public-source allowlist; optionally restore from that exact commit."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parent


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--restore-from", type=Path)
    args = parser.parse_args()
    manifest = json.loads((ROOT / "provenance.json").read_text())
    vendor = ROOT / "vendor/eif"
    for item in manifest["files"]:
        path = item["path"]
        target = vendor / path
        if not target.resolve().is_relative_to(vendor.resolve()):
            raise SystemExit("Path outside vendor directory")
        if args.restore_from:
            data = subprocess.check_output([
                "git", "-C", str(args.restore_from), "show", manifest["commit"] + ":" + path
            ])
        else:
            data = target.read_bytes()
        if hashlib.sha256(data).hexdigest() != item["sha256"]:
            raise SystemExit("Hash mismatch: " + path)
        if args.restore_from:
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
    allowed = {item["path"] for item in manifest["files"]} | {"LICENSE", "NOTICE"}
    actual = {p.relative_to(vendor).as_posix() for p in vendor.rglob("*") if p.is_file()}
    if actual != allowed:
        raise SystemExit("Unexpected/missing vendor files: " + str(sorted(actual ^ allowed)))
    print(f"Verified {len(manifest['files'])} upstream files at {manifest['commit']}")


if __name__ == "__main__":
    main()
