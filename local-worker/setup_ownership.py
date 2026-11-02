"""Owned-resource rollback safety (ONB24, ONB04/ONB25 guards).

Small reusable component for setup rollback. Records only resources this
setup attempt created, revalidates identity at cleanup, refuses anything
unowned, and reports restartable residuals.

Deletion is identity-bound: adapters must re-verify the expected identity
adjacently inside delete_owned_file/delete_owned_dir/stop_owned; adapters
without those methods get fail-safe residuals, never deletion. The setup
lock coordinates cooperating setup processes only; it does not stop an
external same-user writer racing verify-then-act, so the window is narrowed
to one adapter boundary plus private owned directories, and any mismatch
fails safe. No ps/kill here: process stop goes only through the injected
single-PID ProcessOps. No unpair/reset.

Checkpoint sha256 detects accidental corruption, not deliberate forgery;
revalidation plus roots/preserved boundaries hold regardless.

Platform assumptions: POSIX paths (macOS/Linux) via injected FileOps;
Windows junctions are synthetic via FileOps.is_junction and are NOT
Windows runtime qualification.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
from dataclasses import asdict, dataclass, field

__version__ = "1.1.1"
CHECKPOINT_VERSION = 1  # record shapes unchanged since 1.0.0


class OwnershipError(Exception):
    pass


class Refusal(OwnershipError):
    def __init__(self, reason: str, category: str = "refused"):
        super().__init__(reason)
        self.reason = reason
        self.category = category


class CheckpointTamper(OwnershipError):
    pass


# ---- Guards ----

@dataclass(frozen=True)
class Residual:
    kind: str  # file | dir | process
    key: str
    reason: str
    category: str = "refused"
    retryable: bool = False


@dataclass
class CleanupReport:
    removed: list[str] = field(default_factory=list)
    residuals: list[Residual] = field(default_factory=list)
    complete: bool = False
    attempt_id: str = ""


class PreservedGuard:
    """Paths that rollback must never touch (pairing, credentials, prefs)."""

    def __init__(self, preserved_paths):
        self.preserved = [os.path.normpath(str(p)) for p in (preserved_paths or [])]

    def is_preserved(self, path: str, fops=None) -> bool:
        """Lexical check, plus realpath on both sides when fops is given.

        The component always passes fops: a symlink alias pointing into a
        preserved tree (or a preserved entry that is itself a symlink) must
        still match. Unresolvable paths fail closed (treated as preserved).
        """
        norm = os.path.normpath(str(path))
        for p in self.preserved:
            if norm == p or norm.startswith(p + os.sep):
                return True
        if fops is None:
            return False
        try:
            resolved = os.path.normpath(str(fops.realpath(norm)))
        except Exception:
            return True
        for p in self.preserved:
            try:
                rp = os.path.normpath(str(fops.realpath(p)))
            except Exception:
                return True
            if resolved == rp or resolved.startswith(rp + os.sep):
                return True
        return False


def require_explicit_target(target_id, allowed) -> str:
    """ONB04: refuse ambiguous/unlisted placement before any mutation."""
    allowed = list(allowed or [])
    if not target_id or target_id not in allowed:
        raise Refusal(f"ambiguous or unlisted target: {target_id!r}", "target")
    return target_id


class TargetGuard:
    def __init__(self, allowed):
        self.allowed = list(allowed or [])

    def check(self, target_id) -> str:
        return require_explicit_target(target_id, self.allowed)


# ---- Records ----

@dataclass(frozen=True)
class FileRecord:
    path: str
    dev: int
    ino: int
    size: int
    mtime_ns: int
    sha256: str
    uid: int


@dataclass(frozen=True)
class DirRecord:
    path: str
    dev: int
    ino: int
    uid: int


@dataclass(frozen=True)
class ProcessRecord:
    pid: int
    start_time: str
    executable: str
    owner: str


def _canon(payload: dict) -> bytes:
    return json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()


def _full_digest(fops, path: str) -> str:
    """Full SHA-256 over the whole file. No size caps, no skipped middles."""
    d = getattr(fops, "digest_sha256", None)
    if callable(d):
        return str(d(path))
    return hashlib.sha256(bytes(fops.read_bytes(path))).hexdigest()


def _file_expectation(rec: FileRecord) -> dict:
    return {"dev": rec.dev, "ino": rec.ino, "uid": rec.uid, "size": rec.size,
            "mtime_ns": rec.mtime_ns, "sha256": rec.sha256}


def _dir_expectation(rec: DirRecord) -> dict:
    return {"dev": rec.dev, "ino": rec.ino, "uid": rec.uid}


def _proc_expectation(rec: ProcessRecord) -> dict:
    return {"start_time": rec.start_time, "executable": rec.executable,
            "owner": rec.owner}


_SECRET_PATTERNS = [
    re.compile(r"CANARY_[A-Za-z0-9_]+"),
    re.compile(r"(?i)(token|secret|code|password|bearer|api[-_]?key)\s*[:=]\s*\S+"),
]


def redact_text(s: str) -> str:
    out = str(s)
    for pat in _SECRET_PATTERNS:
        out = pat.sub("[REDACTED]", out)
    return out


def redacted_diagnostics(report: CleanupReport) -> str:
    lines = [f"attempt={report.attempt_id or '-'} complete={report.complete}",
             f"removed={len(report.removed)} residuals={len(report.residuals)}"]
    for r in report.residuals:
        lines.append(f"{r.kind} category={r.category} retryable={r.retryable}")
    return redact_text("\n".join(lines))


class OwnershipLedger:
    def __init__(self, roots, attempt_id: str, created_at, preserved: PreservedGuard):
        self.roots = tuple(os.path.normpath(str(r)) for r in roots)
        self.attempt_id = attempt_id
        self.created_at = created_at
        self.preserved = preserved or PreservedGuard([])
        self.files: dict[str, FileRecord | None] = {}
        self.dirs: dict[str, DirRecord | None] = {}
        self.processes: dict[int, ProcessRecord] = {}

    # -- checkpoint (no secrets: hashes + paths only, never contents).
    # The envelope sha256 detects accidental corruption/truncation only; it
    # is NOT authenticity against deliberate same-user forgery. Forgery
    # resistance is private checkpoint storage plus mandatory revalidation
    # and roots/preserved boundaries at cleanup time.
    def to_checkpoint_bytes(self) -> bytes:
        payload = {
            "version": CHECKPOINT_VERSION,
            "attempt_id": self.attempt_id,
            "created_at": self.created_at,
            "roots": list(self.roots),
            "preserved": list(self.preserved.preserved),
            "files": {k: (asdict(v) if v else None) for k, v in self.files.items()},
            "dirs": {k: (asdict(v) if v else None) for k, v in self.dirs.items()},
            "processes": {str(k): asdict(v) for k, v in self.processes.items()},
        }
        return json.dumps({"payload": payload,
                           "sha256": hashlib.sha256(_canon(payload)).hexdigest()},
                          sort_keys=True).encode()

    @staticmethod
    def from_checkpoint_bytes(blob: bytes) -> "OwnershipLedger":
        try:
            env = json.loads(blob.decode("utf-8"))
            payload = env["payload"]
            if payload.get("version") != CHECKPOINT_VERSION:
                raise CheckpointTamper("unsupported checkpoint version")
            expect = hashlib.sha256(_canon(payload)).hexdigest()
            if not hmac.compare_digest(str(env.get("sha256")), expect):
                raise CheckpointTamper("checkpoint integrity mismatch")
        except CheckpointTamper:
            raise
        except Exception as e:
            raise CheckpointTamper(f"unreadable checkpoint: {type(e).__name__}")
        led = OwnershipLedger(roots=payload.get("roots", []),
                              attempt_id=payload.get("attempt_id", ""),
                              created_at=payload.get("created_at", 0),
                              preserved=PreservedGuard(payload.get("preserved", [])))
        try:
            for k, v in (payload.get("files") or {}).items():
                led.files[k] = FileRecord(**v) if v else None
            for k, v in (payload.get("dirs") or {}).items():
                led.dirs[k] = DirRecord(**v) if v else None
            for k, v in (payload.get("processes") or {}).items():
                led.processes[int(k)] = ProcessRecord(**v)
        except Exception:
            raise CheckpointTamper("checkpoint record shape mismatch")
        return led

    # -- snapshots (called right after this attempt creates the resource) --
    def snapshot_file(self, path: str, fops) -> FileRecord:
        if path not in self.files:
            raise Refusal(f"unclaimed file: {path}", "unowned")
        _require_within_roots(path, self.roots, fops)
        if fops.is_symlink(path) or fops.is_junction(path):
            raise Refusal(f"refusing link at owned path: {path}", "link")
        st = fops.lstat(path)
        rec = FileRecord(path=path, dev=st.st_dev, ino=st.st_ino,
                         size=st.st_size, mtime_ns=st.st_mtime_ns,
                         sha256=_full_digest(fops, path),
                         uid=getattr(st, "st_uid", -1))
        self.files[path] = rec
        return rec

    def snapshot_dir(self, path: str, fops) -> DirRecord:
        if path not in self.dirs:
            raise Refusal(f"unclaimed dir: {path}", "unowned")
        _require_within_roots(path, self.roots, fops)
        if fops.is_symlink(path) or fops.is_junction(path):
            raise Refusal(f"refusing link at owned dir: {path}", "link")
        st = fops.lstat(path)
        rec = DirRecord(path=path, dev=st.st_dev, ino=st.st_ino,
                        uid=getattr(st, "st_uid", -1))
        self.dirs[path] = rec
        return rec


def create_ledger(roots, attempt_id: str, clock, preserved=None) -> OwnershipLedger:
    if not list(roots or []):
        raise Refusal("at least one owned root is required", "roots")
    return OwnershipLedger(roots=roots, attempt_id=attempt_id,
                           created_at=clock.now(),
                           preserved=preserved or PreservedGuard([]))


def _require_within_roots(path: str, roots, fops) -> str:
    s = str(path)
    if not s or "\x00" in s:
        raise Refusal("empty or NUL path", "path")
    abs_p = s if os.path.isabs(s) else os.path.join(str(roots[0]), s)
    norm = os.path.normpath(abs_p)
    try:
        resolved = os.path.normpath(str(fops.realpath(norm)))
    except Exception:
        raise Refusal("cannot resolve path; failing closed", "resolve")
    for r in roots:
        try:
            rr = os.path.normpath(str(fops.realpath(r)))
        except Exception:
            rr = os.path.normpath(str(r))
        if resolved == rr or resolved.startswith(rr + os.sep):
            return norm
    raise Refusal(f"path escapes owned roots: {s}", "escape")


def claim_new_file(ledger: OwnershipLedger, path: str, fops) -> None:
    s = str(path)
    if ledger.preserved.is_preserved(s, fops):
        raise Refusal(f"preserved path, never owned: {s}", "preserved")
    _require_within_roots(s, ledger.roots, fops)
    if fops.is_symlink(s) or fops.is_junction(s):
        raise Refusal(f"refusing link claim: {s}", "link")
    if fops.exists(s):
        raise Refusal(f"pre-existing, not owned: {s}", "preexisting")
    if s in ledger.files:
        raise Refusal(f"duplicate claim: {s}", "duplicate")
    ledger.files[s] = None


def claim_new_dir(ledger: OwnershipLedger, path: str, fops) -> None:
    s = str(path)
    if ledger.preserved.is_preserved(s, fops):
        raise Refusal(f"preserved path, never owned: {s}", "preserved")
    _require_within_roots(s, ledger.roots, fops)
    if fops.is_symlink(s) or fops.is_junction(s):
        raise Refusal(f"refusing link claim: {s}", "link")
    if fops.exists(s):
        raise Refusal(f"pre-existing, not owned: {s}", "preexisting")
    if s in ledger.dirs:
        raise Refusal(f"duplicate claim: {s}", "duplicate")
    ledger.dirs[s] = None


def claim_new_process(ledger: OwnershipLedger, pid: int, pops) -> ProcessRecord:
    if not isinstance(pid, int) or pid <= 0:
        raise Refusal(f"invalid pid to own: {pid!r}", "pid")
    if pid in ledger.processes:
        raise Refusal(f"duplicate process claim: {pid}", "duplicate")
    ident = pops.probe(pid)
    if ident is None:
        raise Refusal(f"no such process to own: {pid}", "missing")
    rec = ProcessRecord(pid=pid, start_time=str(ident.start_time),
                        executable=str(ident.executable), owner=str(ident.owner))
    ledger.processes[pid] = rec
    return rec


def _verify_file(rec: FileRecord, fops) -> None:
    if fops.is_symlink(rec.path) or fops.is_junction(rec.path):
        raise Refusal("link at owned path", "link")
    st = fops.lstat(rec.path)
    if (st.st_dev, st.st_ino) != (rec.dev, rec.ino):
        raise Refusal("inode replaced", "replaced")
    if getattr(st, "st_uid", -1) != rec.uid:
        raise Refusal("owner changed", "owner")
    if st.st_size != rec.size or st.st_mtime_ns != rec.mtime_ns:
        raise Refusal("externally modified (stat)", "modified")
    if _full_digest(fops, rec.path) != rec.sha256:
        raise Refusal("externally modified (content)", "modified")


def _verify_process(rec: ProcessRecord, pops):
    ident = pops.probe(rec.pid)
    if ident is None:
        return None  # exited on its own: success, no signal
    if str(ident.start_time) != rec.start_time:
        raise Refusal("PID reused (birth identity mismatch)", "reuse")
    if str(ident.executable) != rec.executable:
        raise Refusal("executable mismatch", "identity")
    if str(ident.owner) != rec.owner:
        raise Refusal("owner mismatch", "identity")
    return ident


def rollback(ledger: OwnershipLedger, fops, pops, prior: CleanupReport | None = None
             ) -> CleanupReport:
    """Remove only precisely verified owned resources. Restartable via prior.

    Never touches preserved/pre-existing/unknown state, never recursive
    deletes, never signals a process group. Unpair/reset are not rollback.
    Destruction goes only through identity-bound adapter methods
    (delete_owned_file/delete_owned_dir/stop_owned) that re-verify the
    expected identity adjacently; adapters without them yield fail-safe
    residuals, never deletion.
    """
    done: set[str] = set(prior.removed) if prior else set()
    report = CleanupReport(removed=list(done), attempt_id=ledger.attempt_id)

    def skip(key):
        return key in done

    # Files first, then dirs (only empty owned dirs), then processes.
    for key in sorted(ledger.files):
        if skip(key):
            continue
        rec = ledger.files[key]
        if ledger.preserved.is_preserved(key, fops):
            report.residuals.append(Residual("file", key, "preserved; never removed",
                                             "preserved"))
            continue
        try:
            _require_within_roots(key, ledger.roots, fops)
        except Refusal as e:
            report.residuals.append(Residual("file", key, e.reason, e.category))
            continue
        if rec is None:
            if fops.exists(key):
                report.residuals.append(Residual("file", key,
                    "claimed but never snapshotted; external file present",
                    "unverified"))
            else:
                report.removed.append(key)
            continue
        if not fops.exists(key):
            report.removed.append(key)  # already gone: idempotent
            continue
        try:
            _verify_file(rec, fops)
        except Refusal as e:
            report.residuals.append(Residual("file", key, e.reason, e.category))
            continue
        except FileNotFoundError:
            report.removed.append(key)
            continue
        except Exception as e:
            report.residuals.append(Residual("file", key,
                f"verify error: {type(e).__name__}", "error", True))
            continue
        deleter = getattr(fops, "delete_owned_file", None)
        if not callable(deleter):
            report.residuals.append(Residual("file", key,
                "adapter lacks identity-bound delete; refusing", "adapter"))
            continue
        try:
            deleter(key, _file_expectation(rec))
            report.removed.append(key)
        except Refusal as e:
            report.residuals.append(Residual("file", key, e.reason, e.category))
        except FileNotFoundError:
            report.removed.append(key)  # vanished in window; absence achieved
        except Exception as e:
            report.residuals.append(Residual("file", key,
                f"remove failed: {type(e).__name__}", "error", True))

    for key in sorted(ledger.dirs):
        if skip(key):
            continue
        rec = ledger.dirs[key]
        if ledger.preserved.is_preserved(key, fops):
            report.residuals.append(Residual("dir", key, "preserved; never removed",
                                             "preserved"))
            continue
        try:
            _require_within_roots(key, ledger.roots, fops)
        except Refusal as e:
            report.residuals.append(Residual("dir", key, e.reason, e.category))
            continue
        if rec is None:
            if fops.exists(key):
                report.residuals.append(Residual("dir", key,
                    "claimed but never snapshotted", "unverified"))
            else:
                report.removed.append(key)
            continue
        if not fops.exists(key):
            report.removed.append(key)
            continue
        try:
            if fops.is_symlink(key) or fops.is_junction(key):
                raise Refusal("link at owned dir", "link")
            st = fops.lstat(key)
            if (st.st_dev, st.st_ino) != (rec.dev, rec.ino):
                raise Refusal("dir inode replaced", "replaced")
            children = fops.listdir(key)
            if children:
                raise Refusal(f"dir not empty ({len(children)} children kept)",
                              "not-empty")
        except Refusal as e:
            report.residuals.append(Residual("dir", key, e.reason, e.category))
            continue
        except FileNotFoundError:
            report.removed.append(key)
            continue
        except Exception as e:
            report.residuals.append(Residual("dir", key,
                f"verify error: {type(e).__name__}", "error", True))
            continue
        deleter = getattr(fops, "delete_owned_dir", None)
        if not callable(deleter):
            report.residuals.append(Residual("dir", key,
                "adapter lacks identity-bound delete; refusing", "adapter"))
            continue
        try:
            deleter(key, _dir_expectation(rec))
            report.removed.append(key)
        except Refusal as e:
            report.residuals.append(Residual("dir", key, e.reason, e.category))
        except FileNotFoundError:
            report.removed.append(key)
        except Exception as e:
            report.residuals.append(Residual("dir", key,
                f"remove failed: {type(e).__name__}", "error", True))

    for pid in sorted(ledger.processes):
        key = f"pid:{pid}"
        if skip(key):
            continue
        rec = ledger.processes[pid]
        try:
            ident = _verify_process(rec, pops)
        except Refusal as e:
            report.residuals.append(Residual("process", key, e.reason, e.category))
            continue
        except Exception as e:
            report.residuals.append(Residual("process", key,
                f"verify error: {type(e).__name__}", "error", True))
            continue
        if ident is None:
            report.removed.append(key)  # already exited
            continue
        stopper = getattr(pops, "stop_owned", None)
        if not callable(stopper):
            report.residuals.append(Residual("process", key,
                "adapter lacks identity-bound stop; refusing", "adapter"))
            continue
        try:
            # Single PID only, never a group. True: stopped; False: the
            # process exited inside the stop window (also success, no signal).
            stopper(pid, _proc_expectation(rec))
            report.removed.append(key)
        except Refusal as e:
            report.residuals.append(Residual("process", key, e.reason, e.category))
        except Exception as e:
            report.residuals.append(Residual("process", key,
                f"terminate failed: {type(e).__name__}", "error", True))

    report.complete = not report.residuals
    return report


class OsFileOps:
    """Production FileOps for POSIX (macOS/Linux).

    delete_owned_file opens O_NOFOLLOW, re-verifies identity plus a full
    streaming digest, then unlinks, then alarms (OwnershipError) if the
    post-unlink link count shows the wrong inode was affected. Adjacent
    check+act narrows the race to one syscall boundary; it does not fully
    close it against a hostile same-directory writer. Private 0700 owned
    directories are the orchestrator's mitigation.
    """

    def lstat(self, path):
        return os.lstat(path)

    def stat(self, path):
        return os.stat(path)

    def exists(self, path):
        try:
            os.lstat(path)
            return True
        except FileNotFoundError:
            return False

    def is_symlink(self, path):
        return os.path.islink(path)

    def is_junction(self, path):
        # POSIX: no junctions. Windows integrators must override via adapter.
        return False

    def read_bytes(self, path):
        with open(path, "rb") as f:
            return f.read()

    def realpath(self, path):
        return os.path.realpath(path)

    def unlink(self, path):
        # Legacy single-step op; rollback uses delete_owned_* instead.
        os.unlink(path)

    def rmdir(self, path):
        # Legacy single-step op; rollback uses delete_owned_* instead.
        os.rmdir(path)

    def listdir(self, path):
        return sorted(os.listdir(path))

    def digest_sha256(self, path):
        h = hashlib.sha256()
        with open(path, "rb") as f:
            for chunk in iter(lambda: f.read(65536), b""):
                h.update(chunk)
        return h.hexdigest()

    def delete_owned_file(self, path, expected):
        if self.is_symlink(path) or self.is_junction(path):
            raise Refusal("link at owned path", "link")
        flags = (os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
                 | getattr(os, "O_CLOEXEC", 0))
        try:
            fd = os.open(path, flags)
        except FileNotFoundError:
            raise
        except OSError as e:
            raise Refusal(f"cannot open owned file: {e}", "open")
        try:
            st = os.fstat(fd)
            if (st.st_dev, st.st_ino) != (expected["dev"], expected["ino"]):
                raise Refusal("inode replaced", "replaced")
            if getattr(st, "st_uid", -1) != expected["uid"]:
                raise Refusal("owner changed", "owner")
            if st.st_size != expected["size"] or st.st_mtime_ns != expected["mtime_ns"]:
                raise Refusal("externally modified (stat)", "modified")
            h = hashlib.sha256()
            while True:
                chunk = os.read(fd, 65536)
                if not chunk:
                    break
                h.update(chunk)
            if h.hexdigest() != expected["sha256"]:
                raise Refusal("externally modified (content)", "modified")
            n1 = st.st_nlink
            os.unlink(path)
            try:
                n2 = os.fstat(fd).st_nlink
            except OSError:
                return  # deleted; post-check unavailable
            if n2 != n1 - 1:
                raise OwnershipError("unlink affected unexpected inode")
        finally:
            os.close(fd)

    def delete_owned_dir(self, path, expected):
        if self.is_symlink(path) or self.is_junction(path):
            raise Refusal("link at owned dir", "link")
        st = os.lstat(path)
        if (st.st_dev, st.st_ino) != (expected["dev"], expected["ino"]):
            raise Refusal("dir inode replaced", "replaced")
        children = sorted(os.listdir(path))
        if children:
            raise Refusal(f"dir not empty ({len(children)} children kept)",
                          "not-empty")
        st2 = os.lstat(path)  # re-lstat: catch an empty-dir swap in the window
        if (st2.st_dev, st2.st_ino) != (expected["dev"], expected["ino"]):
            raise Refusal("dir inode replaced", "replaced")
        os.rmdir(path)
