"""Fixture tests for the private pinned uv bootstrap.

No real download, extraction of a real uv release, or execution of uv happens
here. Synthetic archives are built in memory; downloader, digest, extractor,
and version runner are injected.
"""
from __future__ import annotations

import hashlib
import io
import json
import os
import shutil
import stat
import tarfile
import tempfile
import unittest
import zipfile
from pathlib import Path

import uv_bootstrap as ub

ROOT = Path(__file__).resolve().parent
TAR_ASSET = "uv-x86_64-unknown-linux-gnu.tar.gz"
ZIP_ASSET = "uv-x86_64-pc-windows-msvc.zip"
URL = "https://github.com/astral-sh/uv/releases/download/0.12.12/"


def make_tar(members):
    """members: (name, bytes) or (name, None, 'symlink', target)."""
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w:gz") as bundle:
        for member in members:
            name, data = member[0], member[1]
            info = tarfile.TarInfo(name)
            if len(member) > 2 and member[2] == "symlink":
                info.type = tarfile.SYMTYPE
                info.linkname = member[3]
                bundle.addfile(info)
            else:
                info.size = len(data)
                info.mode = 0o755
                bundle.addfile(info, io.BytesIO(data))
    return buffer.getvalue()


def make_zip(members):
    """members: (name, bytes) or (name, None, 'symlink', target)."""
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as bundle:
        for member in members:
            name, data = member[0], member[1]
            info = zipfile.ZipInfo(name)
            info.external_attr = (stat.S_IFREG | 0o755) << 16
            if len(member) > 2 and member[2] == "symlink":
                info.external_attr = (stat.S_IFLNK | 0o777) << 16
                bundle.writestr(info, member[3])
            else:
                bundle.writestr(info, data)
    return buffer.getvalue()


def manifest_for(name, payload):
    return ub.validate_manifest({
        "version": ub.VERSION, "source": ub.SOURCE_URL,
        "assets": [{"name": name, "url": URL + name,
                    "sha256": hashlib.sha256(payload).hexdigest()}],
    })


class FakeDownloader:
    def __init__(self, payload):
        self.payload = payload
        self.calls = []

    def __call__(self, url, destination, *, timeout, max_bytes):
        self.calls.append({"url": url, "timeout": timeout, "max_bytes": max_bytes})
        Path(destination).write_bytes(self.payload)


class FakeRunner:
    def __init__(self, stdout="uv 0.12.12 (synthetic)\n", returncode=0):
        self.stdout = stdout
        self.returncode = returncode
        self.calls = []

    def __call__(self, argv, *, timeout):
        self.calls.append({"argv": list(argv), "timeout": timeout})
        return type("Result", (), {"stdout": self.stdout, "returncode": self.returncode,
                                   "stderr": ""})()


class ManifestTests(unittest.TestCase):
    def test_repository_manifest_pins_the_official_release_and_digests(self):
        manifest = ub.load_manifest()
        self.assertEqual(manifest["version"], "0.12.12")
        self.assertEqual(manifest["source"], ub.SOURCE_URL)
        self.assertEqual(len(manifest["assets"]), 5)
        by_name = {a["name"]: a["sha256"] for a in manifest["assets"]}
        self.assertEqual(by_name["uv-x86_64-pc-windows-msvc.zip"],
                         "3d54912924c36e862c14f427d04f2ed70a99e8001d1c30caa101f6d5711626d5")
        self.assertEqual(by_name["uv-aarch64-apple-darwin.tar.gz"],
                         "46740540b63fdee9a6cb2e19baf3f1f475b850c440a33e63455087a6871263f1")
        for asset in manifest["assets"]:
            self.assertTrue(asset["url"].startswith(URL))
            self.assertRegex(asset["sha256"], r"^[a-f0-9]{64}$")

    def test_manifest_rejects_wrong_version_url_asset_or_digest(self):
        base = {"version": ub.VERSION, "source": ub.SOURCE_URL,
                "assets": [{"name": TAR_ASSET, "url": URL + TAR_ASSET,
                            "sha256": "a" * 64}]}
        good = json.loads(json.dumps(base))
        for mutate in (
                lambda d: d.update(version="0.12.11"),
                lambda d: d.update(source="https://example.invalid/uv"),
                lambda d: d["assets"][0].update(url="https://example.invalid/uv.tar.gz"),
                lambda d: d["assets"][0].update(name="uv-source.tar.gz"),
                lambda d: d["assets"][0].update(sha256="not-a-digest"),
                lambda d: d["assets"][0].update(sha256="A" * 64)):
            data = json.loads(json.dumps(good))
            mutate(data)
            with self.assertRaises(ub.BootstrapError):
                ub.validate_manifest(data)

    def test_platform_selection_covers_only_the_five_pinned_archives(self):
        manifest = ub.load_manifest()
        cases = {
            ("win32", "amd64"): "uv-x86_64-pc-windows-msvc.zip",
            ("darwin", "arm64"): "uv-aarch64-apple-darwin.tar.gz",
            ("darwin", "x86_64"): "uv-x86_64-apple-darwin.tar.gz",
            ("linux", "aarch64"): "uv-aarch64-unknown-linux-gnu.tar.gz",
            ("linux", "x86_64"): "uv-x86_64-unknown-linux-gnu.tar.gz",
        }
        for key, name in cases.items():
            asset = ub.select_asset(manifest, system=key[0], machine=key[1])
            self.assertEqual(asset["name"], name)
        with self.assertRaises(ub.BootstrapError) as raised:
            ub.select_asset(manifest, system="freebsd", machine="x86_64")
        self.assertEqual(raised.exception.exit_code, ub.EXIT_PLATFORM)

    def test_windows_x64_is_the_only_qualified_label(self):
        manifest = ub.load_manifest()
        self.assertTrue(ub.select_asset(manifest, "win32", "amd64")["qualified"])
        self.assertFalse(ub.select_asset(manifest, "darwin", "arm64")["qualified"])


class EnsureTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.data = Path(self.tmp.name) / "worker data"
        self.payload = make_tar([("uv-x86_64-unknown-linux-gnu/uv", b"synthetic uv binary")])
        self.manifest = manifest_for(TAR_ASSET, self.payload)

    def test_download_verifies_digest_then_extracts_private_cache(self):
        downloader = FakeDownloader(self.payload)
        runner = FakeRunner()
        seen = []

        def extractor(archive, asset, destination):
            seen.append({"sha256": ub.sha256_file(archive), "asset": asset["name"]})
            ub.extract_uv(archive, asset, destination)

        result = ub.ensure_uv(data_dir=self.data, manifest=self.manifest,
                              system="linux", machine="x86_64",
                              downloader=downloader, extractor=extractor, runner=runner)
        self.assertEqual(result["source"], "download")
        self.assertEqual(result["archive_sha256"], self.manifest["assets"][0]["sha256"])
        self.assertEqual(len(downloader.calls), 1)
        self.assertEqual(downloader.calls[0]["max_bytes"], ub.MAX_ARCHIVE_BYTES)
        self.assertEqual(seen[0]["sha256"], self.manifest["assets"][0]["sha256"])
        self.assertTrue(result["path"].is_file())
        self.assertEqual(result["path"].read_bytes(), b"synthetic uv binary")
        self.assertEqual(stat.S_IMODE(result["path"].stat().st_mode), 0o700)
        cache = result["path"].parent
        self.assertEqual(cache.name, ub.VERSION)
        self.assertEqual(cache.parent.name, "uv-bootstrap")
        self.assertEqual(stat.S_IMODE(cache.stat().st_mode), 0o700)
        self.assertEqual(runner.calls, [{"argv": [str(result["path"]), "--version"],
                                        "timeout": 30.0}])

    def test_digest_mismatch_stops_before_extraction_or_execution(self):
        called = []
        runner = FakeRunner()

        def extractor(_archive, _asset, _destination):
            called.append("extract")
            raise AssertionError("extractor must not run after a digest mismatch")

        with self.assertRaises(ub.BootstrapError) as raised:
            ub.ensure_uv(data_dir=self.data, manifest=self.manifest,
                         system="linux", machine="x86_64",
                         downloader=FakeDownloader(b"tampered"),
                         digest=lambda _path: "0" * 64,
                         extractor=extractor, runner=runner, out=lambda _line: None)
        self.assertEqual(raised.exception.exit_code, ub.EXIT_VERIFY)
        self.assertEqual(called, [])
        self.assertEqual(runner.calls, [])
        self.assertFalse((self.data / "uv-bootstrap" / ub.VERSION / "uv").exists())

    def test_cache_reuse_does_not_download_again(self):
        first = ub.ensure_uv(data_dir=self.data, manifest=self.manifest,
                             system="linux", machine="x86_64",
                             downloader=FakeDownloader(self.payload),
                             runner=FakeRunner())
        second_downloader = FakeDownloader(b"must not be used")
        second = ub.ensure_uv(data_dir=self.data, manifest=self.manifest,
                              system="linux", machine="x86_64",
                              downloader=second_downloader, runner=FakeRunner())
        self.assertEqual(second["source"], "cache")
        self.assertEqual(second["path"], first["path"])
        self.assertEqual(second_downloader.calls, [])

    def test_unknown_platform_is_refused_before_download(self):
        downloader = FakeDownloader(self.payload)
        with self.assertRaises(ub.BootstrapError) as raised:
            ub.ensure_uv(data_dir=self.data, manifest=self.manifest,
                         system="freebsd", machine="x86_64",
                         downloader=downloader, runner=FakeRunner())
        self.assertEqual(raised.exception.exit_code, ub.EXIT_PLATFORM)
        self.assertEqual(downloader.calls, [])

    def test_binary_version_must_be_exactly_pinned(self):
        with self.assertRaises(ub.BootstrapError) as raised:
            ub.ensure_uv(data_dir=self.data, manifest=self.manifest,
                         system="linux", machine="x86_64",
                         downloader=FakeDownloader(self.payload),
                         runner=FakeRunner("uv 0.12.11\n"))
        self.assertEqual(raised.exception.exit_code, ub.EXIT_PREREQ)


class ArchiveSafetyTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dest = Path(self.tmp.name) / "uv"
        self.asset = ub.select_asset(ub.load_manifest(), "linux", "x86_64")

    def extract(self, payload):
        archive = Path(self.tmp.name) / "archive.tar.gz"
        archive.write_bytes(payload)
        ub.extract_uv(archive, self.asset, self.dest)

    def test_safe_tar_with_extra_regular_files_extracts_only_uv(self):
        payload = make_tar([
            ("uv-x86_64-unknown-linux-gnu/uv", b"binary"),
            ("uv-x86_64-unknown-linux-gnu/uvx", b"companion"),
            ("uv-x86_64-unknown-linux-gnu/LICENSE", b"license"),
        ])
        self.extract(payload)
        self.assertEqual(self.dest.read_bytes(), b"binary")
        self.assertFalse((Path(self.tmp.name) / "uvx").exists())

    def test_parent_traversal_is_refused(self):
        payload = make_tar([("../evil", b"x"), ("uv", b"binary")])
        with self.assertRaises(ub.BootstrapError) as raised:
            self.extract(payload)
        self.assertEqual(raised.exception.exit_code, ub.EXIT_ARCHIVE)
        self.assertFalse(self.dest.exists())

    def test_absolute_path_is_refused(self):
        payload = make_tar([("/tmp/evil", b"x"), ("uv", b"binary")])
        with self.assertRaises(ub.BootstrapError):
            self.extract(payload)

    def test_symlink_member_is_refused(self):
        payload = make_tar([("uv", None, "symlink", "/etc/passwd")])
        with self.assertRaises(ub.BootstrapError):
            self.extract(payload)

    def test_archive_must_contain_exactly_one_uv(self):
        with self.assertRaises(ub.BootstrapError):
            self.extract(make_tar([("uvx", b"not uv")]))
        with self.assertRaises(ub.BootstrapError):
            self.extract(make_tar([("a/uv", b"one"), ("b/uv", b"two")]))

    def test_windows_zip_selects_uv_exe_and_rejects_symlink(self):
        asset = ub.select_asset(ub.load_manifest(), "win32", "amd64")
        payload = make_zip([("uv-x86_64-pc-windows-msvc/uv.exe", b"windows binary")])
        archive = Path(self.tmp.name) / "archive.zip"
        archive.write_bytes(payload)
        ub.extract_uv(archive, asset, self.dest)
        self.assertEqual(self.dest.read_bytes(), b"windows binary")

        bad = make_zip([("uv.exe", None, "symlink", "/etc/passwd")])
        archive.write_bytes(bad)
        with self.assertRaises(ub.BootstrapError):
            ub.extract_uv(archive, asset, self.dest)

    def test_empty_binary_is_refused(self):
        with self.assertRaises(ub.BootstrapError):
            self.extract(make_tar([("uv", b"")]))


if __name__ == "__main__":
    unittest.main()
