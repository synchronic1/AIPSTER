#!/usr/bin/env python3
"""Private, digest-pinned bootstrap for the exact uv build AIPSTER pins.

This helper exists for a cold start where no suitable uv is on PATH. It never
upgrades or replaces a global uv. Instead it downloads one official Astral
release archive into a user-private cache, verifies the fixed SHA-256 from
``uv-artifacts-0.12.12.json`` *before* opening the archive, rejects unsafe
archive members, extracts only the ``uv``/``uv.exe`` binary, and reports its
path. The caller puts that private directory on PATH (and AIPSTER_UV) for the
child process only.

The archive digest is the binary archive digest published for the release,
not the digest of a detached ``.sha256`` file.

No network or child process runs during fixture tests: downloader, digest,
archive extractor, and version runner are injectable.
"""
from __future__ import annotations

import argparse
import hashlib
import hmac
import io
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import time
import zipfile
from pathlib import Path, PurePosixPath
from typing import Any, Callable, Dict, Optional, Sequence, Tuple
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

ROOT = Path(__file__).resolve().parent
VERSION = "0.12.12"
MANIFEST = ROOT / "uv-artifacts-0.12.12.json"
SCHEMA = "aipster-uv-cache/1"
RELEASE_URL_PREFIX = "https://github.com/astral-sh/uv/releases/download/0.12.12/"
SOURCE_URL = "https://github.com/astral-sh/uv/releases/tag/0.12.12"
MAX_ARCHIVE_BYTES = 200 * 1024 * 1024
MAX_BINARY_BYTES = 200 * 1024 * 1024
MAX_REDIRECT_HOSTS = {
    "github.com",
    "objects.githubusercontent.com",
    "release-assets.githubusercontent.com",
}

EXIT_OK = 0
EXIT_USAGE = 2
EXIT_PREREQ = 3
EXIT_DOWNLOAD = 4
EXIT_VERIFY = 5
EXIT_ARCHIVE = 6
EXIT_PLATFORM = 7

_SHA_RE = re.compile(r"^[a-f0-9]{64}$")
_EXPECTED_ASSETS = {
    "uv-aarch64-apple-darwin.tar.gz",
    "uv-aarch64-unknown-linux-gnu.tar.gz",
    "uv-x86_64-apple-darwin.tar.gz",
    "uv-x86_64-pc-windows-msvc.zip",
    "uv-x86_64-unknown-linux-gnu.tar.gz",
}
_ASSET_NAMES = {
    ("win32", "amd64"): ("uv-x86_64-pc-windows-msvc.zip", "uv.exe", "Windows x64"),
    ("win32", "x86_64"): ("uv-x86_64-pc-windows-msvc.zip", "uv.exe", "Windows x64"),
    ("win32", "x64"): ("uv-x86_64-pc-windows-msvc.zip", "uv.exe", "Windows x64"),
    ("darwin", "arm64"): ("uv-aarch64-apple-darwin.tar.gz", "uv", "macOS arm64 (experimental)"),
    ("darwin", "aarch64"): ("uv-aarch64-apple-darwin.tar.gz", "uv", "macOS arm64 (experimental)"),
    ("darwin", "x86_64"): ("uv-x86_64-apple-darwin.tar.gz", "uv", "macOS x86_64 (experimental)"),
    ("darwin", "amd64"): ("uv-x86_64-apple-darwin.tar.gz", "uv", "macOS x86_64 (experimental)"),
    ("linux", "aarch64"): ("uv-aarch64-unknown-linux-gnu.tar.gz", "uv", "Linux aarch64 (experimental)"),
    ("linux", "arm64"): ("uv-aarch64-unknown-linux-gnu.tar.gz", "uv", "Linux aarch64 (experimental)"),
    ("linux", "x86_64"): ("uv-x86_64-unknown-linux-gnu.tar.gz", "uv", "Linux x86_64 (experimental)"),
    ("linux", "amd64"): ("uv-x86_64-unknown-linux-gnu.tar.gz", "uv", "Linux x86_64 (experimental)"),
}


class BootstrapError(RuntimeError):
    def __init__(self, code: str, message: str, exit_code: int = EXIT_USAGE):
        super().__init__(message)
        self.code = code
        self.exit_code = exit_code


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        while True:
            chunk = handle.read(1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest()


def validate_manifest(data: Any) -> Dict[str, Any]:
    if not isinstance(data, dict):
        raise BootstrapError("BAD_MANIFEST", "uv artifact manifest is not an object")
    if data.get("version") != VERSION:
        raise BootstrapError("BAD_MANIFEST", "uv artifact manifest pins a different version")
    if data.get("source") != SOURCE_URL:
        raise BootstrapError("BAD_MANIFEST", "uv artifact manifest has an unexpected source")
    assets = data.get("assets")
    if not isinstance(assets, list) or not assets:
        raise BootstrapError("BAD_MANIFEST", "uv artifact manifest has no assets")
    seen = set()
    checked = []
    for asset in assets:
        if not isinstance(asset, dict):
            raise BootstrapError("BAD_MANIFEST", "uv artifact entry is malformed")
        name = asset.get("name")
        url = asset.get("url")
        digest = asset.get("sha256")
        if not isinstance(name, str) or not name or "/" in name or "\\" in name:
            raise BootstrapError("BAD_MANIFEST", "uv artifact has an unsafe asset name")
        if name not in _EXPECTED_ASSETS:
            raise BootstrapError("BAD_MANIFEST", "uv artifact is not one of the pinned release assets")
        if name in seen:
            raise BootstrapError("BAD_MANIFEST", "uv artifact manifest repeats an asset")
        if not isinstance(url, str) or not url.startswith(RELEASE_URL_PREFIX):
            raise BootstrapError("BAD_MANIFEST", "uv artifact URL is not the pinned release")
        if not isinstance(digest, str) or not _SHA_RE.match(digest):
            raise BootstrapError("BAD_MANIFEST", "uv artifact digest is not a fixed SHA-256")
        seen.add(name)
        checked.append({"name": name, "url": url, "sha256": digest})
    return {"version": VERSION, "source": SOURCE_URL, "assets": checked}


def load_manifest(path: Path = MANIFEST) -> Dict[str, Any]:
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError, UnicodeError) as exc:
        raise BootstrapError("BAD_MANIFEST", "cannot read the pinned uv artifact manifest") from exc
    return validate_manifest(data)


def select_asset(manifest: Dict[str, Any], system: Optional[str] = None,
                 machine: Optional[str] = None) -> Dict[str, Any]:
    system = (system if system is not None else sys.platform).lower()
    machine = (machine if machine is not None else os.uname().machine if hasattr(os, "uname")
               else os.environ.get("PROCESSOR_ARCHITECTURE", "")).lower()
    key = (system, machine)
    selected = _ASSET_NAMES.get(key)
    if selected is None:
        raise BootstrapError(
            "UNSUPPORTED_PLATFORM",
            "no pinned uv artifact for %s/%s; use a qualified packaged installer"
            % (system, machine or "unknown"), EXIT_PLATFORM)
    name, binary, label = selected
    for asset in manifest["assets"]:
        if asset["name"] == name:
            result = dict(asset)
            result.update(binary=binary, platform="%s/%s" % (system, machine), label=label,
                          qualified=(key in (("win32", "amd64"), ("win32", "x86_64"),
                                             ("win32", "x64"))))
            return result
    raise BootstrapError("BAD_MANIFEST", "pinned uv asset is missing from the manifest")


def _default_data_dir() -> Path:
    override = os.environ.get("AIPSTER_WORKER_DATA")
    if override:
        return Path(override)
    if os.name == "nt":
        local = os.environ.get("LOCALAPPDATA")
        if not local:
            raise BootstrapError("NO_DATA_DIR", "LOCALAPPDATA is not set; cannot locate the private cache",
                                 EXIT_PREREQ)
        return Path(local) / "AIPSTER-Worker"
    return Path.home() / ".local" / "share" / "aipster-worker"


def private_cache_dir(data_dir: Optional[Path] = None) -> Path:
    """Create/verify a user-only cache without touching a global installation."""
    try:
        import pairing  # noqa: PLC0415 - same reviewed private-storage helper
    except (ImportError, OSError) as exc:
        raise BootstrapError("PRIVATE_CACHE", "private storage helper is unavailable",
                             EXIT_PREREQ) from exc
    data = Path(data_dir) if data_dir is not None else _default_data_dir()
    try:
        pairing.private_dir(data)
        base = data / "uv-bootstrap"
        pairing.private_dir(base)
        cache = base / VERSION
        pairing.private_dir(cache)
    except Exception as exc:  # noqa: BLE001 - fail closed on shared/linked storage
        raise BootstrapError("PRIVATE_CACHE",
                             "cannot establish a user-only uv cache: " + str(exc), EXIT_PREREQ) from exc
    return cache


def cache_paths(cache: Path, asset: Dict[str, Any]) -> Tuple[Path, Path]:
    return cache / asset["binary"], cache / "artifact.json"


def _valid_cached(cache: Path, asset: Dict[str, Any],
                  digest: Callable[[Path], str]) -> Optional[Dict[str, Any]]:
    binary, marker = cache_paths(cache, asset)
    try:
        if binary.is_symlink() or not binary.is_file():
            return None
        record = json.loads(marker.read_text(encoding="utf-8"))
        if not isinstance(record, dict):
            return None
        if (record.get("schema") != SCHEMA or record.get("version") != VERSION
                or record.get("asset") != asset["name"]
                or record.get("archive_sha256") != asset["sha256"]
                or record.get("platform") != asset["platform"]):
            return None
        expected_binary = record.get("binary_sha256")
        if not isinstance(expected_binary, str) or not _SHA_RE.match(expected_binary):
            return None
        if not hmac.compare_digest(digest(binary), expected_binary):
            return None
        if os.name != "nt":
            if binary.stat().st_uid != os.getuid() or binary.stat().st_mode & 0o077:
                return None
        return {"path": binary, "binary_sha256": expected_binary}
    except (OSError, ValueError, UnicodeError):
        return None


class _GithubRedirects(HTTPRedirectHandler):
    """Allow only HTTPS GitHub release/download hosts; never forward credentials."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        split = urlsplit(newurl)
        host = (split.hostname or "").lower()
        if split.scheme != "https" or split.username or split.password:
            return None
        if host not in MAX_REDIRECT_HOSTS and not host.endswith(".githubusercontent.com"):
            return None
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def _default_download(url: str, destination: Path, *, timeout: float, max_bytes: int) -> None:
    split = urlsplit(url)
    if split.scheme != "https" or split.hostname != "github.com":
        raise BootstrapError("DOWNLOAD_REFUSED", "refusing a non-GitHub uv download URL",
                             EXIT_DOWNLOAD)
    request = Request(url, headers={"User-Agent": "aipster-uv-bootstrap/1",
                                    "Accept": "application/octet-stream"})
    opener = build_opener(_GithubRedirects())
    try:
        with opener.open(request, timeout=timeout) as response:
            final = urlsplit(response.geturl())
            host = (final.hostname or "").lower()
            if final.scheme != "https" or (host not in MAX_REDIRECT_HOSTS
                                           and not host.endswith(".githubusercontent.com")):
                raise BootstrapError("DOWNLOAD_REFUSED", "uv download redirected to an unapproved host",
                                     EXIT_DOWNLOAD)
            length = response.headers.get("Content-Length")
            if length is not None:
                try:
                    if int(length) > max_bytes:
                        raise BootstrapError("DOWNLOAD_TOO_LARGE", "uv archive exceeds the size limit",
                                             EXIT_DOWNLOAD)
                except ValueError:
                    pass
            written = 0
            with open(destination, "wb") as handle:
                while True:
                    chunk = response.read(1024 * 1024)
                    if not chunk:
                        break
                    written += len(chunk)
                    if written > max_bytes:
                        raise BootstrapError("DOWNLOAD_TOO_LARGE", "uv archive exceeds the size limit",
                                             EXIT_DOWNLOAD)
                    handle.write(chunk)
                handle.flush()
                os.fsync(handle.fileno())
    except BootstrapError:
        raise
    except (HTTPError, URLError, OSError, ValueError) as exc:
        raise BootstrapError("DOWNLOAD_FAILED", "could not download the pinned uv archive",
                             EXIT_DOWNLOAD) from exc


def _safe_name(name: str) -> str:
    normalized = name.replace("\\", "/")
    if "\x00" in normalized or any(ord(ch) < 32 for ch in normalized):
        raise BootstrapError("UNSAFE_ARCHIVE", "uv archive contains a control character in a name",
                             EXIT_ARCHIVE)
    if normalized.startswith("/") or re.match(r"^[A-Za-z]:", normalized):
        raise BootstrapError("UNSAFE_ARCHIVE", "uv archive contains an absolute path", EXIT_ARCHIVE)
    parts = PurePosixPath(normalized).parts
    if any(part == ".." for part in parts):
        raise BootstrapError("UNSAFE_ARCHIVE", "uv archive contains a parent traversal", EXIT_ARCHIVE)
    return normalized


def _copy_bounded(source, destination: Path) -> None:
    written = 0
    with open(destination, "wb") as handle:
        while True:
            chunk = source.read(1024 * 1024)
            if not chunk:
                break
            written += len(chunk)
            if written > MAX_BINARY_BYTES:
                raise BootstrapError("UNSAFE_ARCHIVE", "uv binary exceeds the size limit", EXIT_ARCHIVE)
            handle.write(chunk)
        handle.flush()
        os.fsync(handle.fileno())


def extract_uv(archive: Path, asset: Dict[str, Any], destination: Path) -> None:
    """Extract exactly one uv binary; reject links, traversal, and odd members."""
    expected = asset["binary"]
    temp_fd, temp_name = tempfile.mkstemp(prefix=".uv-extract-", dir=str(destination.parent))
    os.close(temp_fd)
    temp_path = Path(temp_name)
    found = []

    def consider(name: str, regular: bool, size: int) -> None:
        safe = _safe_name(name)
        if not regular:
            raise BootstrapError("UNSAFE_ARCHIVE",
                                 "uv archive contains a non-regular member: " + safe, EXIT_ARCHIVE)
        if size > MAX_BINARY_BYTES:
            raise BootstrapError("UNSAFE_ARCHIVE", "uv archive member is too large", EXIT_ARCHIVE)
        if PurePosixPath(safe).name == expected:
            found.append(safe)

    try:
        if asset["name"].endswith(".zip"):
            with zipfile.ZipFile(archive) as bundle:
                for info in bundle.infolist():
                    name = info.filename
                    if name.endswith("/"):
                        _safe_name(name)
                        continue
                    mode = (info.external_attr >> 16) & 0xFFFF
                    if stat.S_ISLNK(mode):
                        raise BootstrapError("UNSAFE_ARCHIVE", "uv archive contains a symlink",
                                             EXIT_ARCHIVE)
                    if info.flag_bits & 0x1:
                        raise BootstrapError("UNSAFE_ARCHIVE", "uv archive member is encrypted",
                                             EXIT_ARCHIVE)
                    consider(name, True, info.file_size)
                if len(found) != 1:
                    raise BootstrapError("UNSAFE_ARCHIVE",
                                         "uv archive must contain exactly one " + expected,
                                         EXIT_ARCHIVE)
                with bundle.open(found[0]) as source:
                    _copy_bounded(source, temp_path)
        elif asset["name"].endswith((".tar.gz", ".tgz")):
            with tarfile.open(archive, "r:gz") as bundle:
                for member in bundle.getmembers():
                    if member.isdir():
                        _safe_name(member.name)
                        continue
                    if not member.isfile():
                        raise BootstrapError("UNSAFE_ARCHIVE",
                                             "uv archive contains a link or special member",
                                             EXIT_ARCHIVE)
                    consider(member.name, True, member.size)
                if len(found) != 1:
                    raise BootstrapError("UNSAFE_ARCHIVE",
                                         "uv archive must contain exactly one " + expected,
                                         EXIT_ARCHIVE)
                source = bundle.extractfile(found[0])
                if source is None:
                    raise BootstrapError("UNSAFE_ARCHIVE", "cannot read the uv binary member",
                                         EXIT_ARCHIVE)
                with source:
                    _copy_bounded(source, temp_path)
        else:
            raise BootstrapError("UNSAFE_ARCHIVE", "unsupported uv archive type", EXIT_ARCHIVE)
        if temp_path.stat().st_size <= 0:
            raise BootstrapError("UNSAFE_ARCHIVE", "uv archive produced an empty binary", EXIT_ARCHIVE)
        if os.name != "nt":
            temp_path.chmod(0o700)
        os.replace(temp_path, destination)
    finally:
        try:
            temp_path.unlink()
        except OSError:
            pass


def _default_runner(argv: Sequence[str], *, timeout: float):
    return subprocess.run(list(argv), capture_output=True, text=True, timeout=timeout,
                          stdin=subprocess.DEVNULL, env={
                              "PATH": os.environ.get("PATH", ""),
                              "HOME": os.environ.get("HOME", ""),
                              "TMPDIR": os.environ.get("TMPDIR", ""),
                              "SYSTEMROOT": os.environ.get("SYSTEMROOT", ""),
                              "WINDIR": os.environ.get("WINDIR", ""),
                          })


def _version_ok(stdout: str) -> bool:
    parts = (stdout or "").strip().split()
    return len(parts) >= 2 and parts[0] == "uv" and parts[1] == VERSION


def ensure_uv(*, data_dir: Optional[Path] = None, manifest: Optional[Dict[str, Any]] = None,
              system: Optional[str] = None, machine: Optional[str] = None,
              downloader: Optional[Callable[..., None]] = None,
              digest: Callable[[Path], str] = sha256_file,
              extractor: Callable[[Path, Dict[str, Any], Path], None] = extract_uv,
              runner: Callable[..., Any] = _default_runner,
              timeout: float = 120.0, out: Callable[[str], None] = lambda line: None) -> Dict[str, Any]:
    manifest = manifest or load_manifest()
    asset = select_asset(manifest, system=system, machine=machine)
    if not asset["qualified"]:
        out("uv bootstrap: %s is experimental; Windows x64 is the only qualified target"
            % asset["label"])
    cache = private_cache_dir(data_dir)
    cached = _valid_cached(cache, asset, digest)
    if cached is not None:
        result = {"schema": SCHEMA, "version": VERSION, "path": cached["path"],
                  "source": "cache", "asset": asset["name"], "platform": asset["platform"],
                  "label": asset["label"], "qualified": asset["qualified"],
                  "archive_sha256": asset["sha256"],
                  "binary_sha256": cached["binary_sha256"]}
    else:
        binary, marker = cache_paths(cache, asset)
        fd, temp_name = tempfile.mkstemp(prefix=".uv-download-", dir=str(cache))
        os.close(fd)
        archive = Path(temp_name)
        try:
            _default = _default_download
            (downloader or _default)(asset["url"], archive, timeout=timeout,
                                     max_bytes=MAX_ARCHIVE_BYTES)
            if archive.is_symlink() or not archive.is_file():
                raise BootstrapError("DOWNLOAD_FAILED", "uv download did not produce a regular file",
                                     EXIT_DOWNLOAD)
            actual = digest(archive)
            if not hmac.compare_digest(actual, asset["sha256"]):
                raise BootstrapError("DIGEST_MISMATCH",
                                     "downloaded uv archive does not match the fixed digest",
                                     EXIT_VERIFY)
            # The digest is checked above, before this extractor sees the archive.
            extractor(archive, asset, binary)
            binary_digest = digest(binary)
            record = {
                "schema": SCHEMA, "version": VERSION, "asset": asset["name"],
                "platform": asset["platform"], "archive_sha256": asset["sha256"],
                "binary_sha256": binary_digest, "created_at": time.strftime(
                    "%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            }
            try:
                import pairing  # noqa: PLC0415
                pairing.write_private(marker, json.dumps(record, indent=2, sort_keys=True) + "\n")
            except Exception as exc:  # noqa: BLE001
                raise BootstrapError("PRIVATE_CACHE", "cannot record the private uv cache",
                                     EXIT_PREREQ) from exc
        finally:
            try:
                archive.unlink()
            except OSError:
                pass
        result = {"schema": SCHEMA, "version": VERSION, "path": binary,
                  "source": "download", "asset": asset["name"],
                  "platform": asset["platform"], "label": asset["label"],
                  "qualified": asset["qualified"], "archive_sha256": asset["sha256"],
                  "binary_sha256": binary_digest}
    try:
        check = runner([str(result["path"]), "--version"], timeout=min(timeout, 30.0))
    except (OSError, subprocess.SubprocessError) as exc:
        raise BootstrapError("UV_EXEC", "the pinned uv binary could not be executed",
                             EXIT_PREREQ) from exc
    if getattr(check, "returncode", 1) != 0 or not _version_ok(getattr(check, "stdout", "")):
        raise BootstrapError("UV_VERSION", "the private uv binary is not " + VERSION, EXIT_PREREQ)
    return result


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="uv_bootstrap.py",
        description="Provision the pinned uv 0.12.12 into a private cache; never modify a global uv.")
    parser.add_argument("--data-dir", default=None,
                        help="worker data dir (default: AIPSTER_WORKER_DATA or the user data dir)")
    parser.add_argument("--manifest", default=None, help="pinned uv artifact manifest")
    parser.add_argument("--print-path", action="store_true",
                        help="print only the private uv executable path")
    parser.add_argument("--json", action="store_true", help="print a JSON result")
    parser.add_argument("--timeout", type=float, default=120.0)
    return parser


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = build_parser()
    try:
        args = parser.parse_args(argv)
    except SystemExit as exc:
        return int(exc.code)
    try:
        manifest = load_manifest(Path(args.manifest) if args.manifest else MANIFEST)
        result = ensure_uv(data_dir=Path(args.data_dir) if args.data_dir else None,
                           manifest=manifest, timeout=args.timeout,
                           out=lambda line: print(line, file=sys.stderr, flush=True))
    except BootstrapError as exc:
        print("uv bootstrap: BLOCKED [%s] %s" % (exc.code, exc), file=sys.stderr)
        return exc.exit_code
    except KeyboardInterrupt:
        print("uv bootstrap: interrupted", file=sys.stderr)
        return 130
    except Exception as exc:  # noqa: BLE001 - never print archive or credential content
        print("uv bootstrap: FAILED [INTERNAL] %s" % type(exc).__name__, file=sys.stderr)
        return EXIT_PREREQ
    if args.json:
        printable = dict(result)
        printable["path"] = str(printable["path"])
        print(json.dumps(printable, indent=2, sort_keys=True))
    else:
        print(str(result["path"]))
    return EXIT_OK


if __name__ == "__main__":
    raise SystemExit(main())
