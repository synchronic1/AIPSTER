"""Native private Windows storage. Standard library only; never changes privileges.

Existing paths must already belong to the process user. A caller may pass
new=True ONLY immediately after exclusive creation (mkdir without exist_ok,
mkstemp, or another O_EXCL operation), never based on caller-supplied metadata.
Such a new path may inherit the process token's default owner, e.g. the local
Administrators group under an elevated runner. Only that default owner may be
normalized to the user SID. Every successful write is verified by read-back.
"""
from contextlib import contextmanager
import ctypes
from ctypes import wintypes as w
import os
from pathlib import Path

OWNER_SECURITY_INFORMATION = 0x1
DACL_SECURITY_INFORMATION = 0x4
PROTECTED_DACL_SECURITY_INFORMATION = 0x80000000
SE_DACL_PROTECTED = 0x1000
FILE_ALL_ACCESS = 0x001F01FF
_API = None


class PrivateStorageError(OSError):
    def __init__(self, code, reason, user='unavailable', default_owner='unavailable', owner='unavailable'):
        # All fields originate from native status codes/SIDs and fixed reason
        # labels. No file path, file content, environment value or raw error text.
        self.code, self.reason = int(code), reason
        self.user_sid, self.default_owner_sid, self.owner_sid = user, default_owner, owner
        super().__init__(f'private ACL rejected: rc={self.code} reason={reason} '
                         f'owner_sid={owner} process_sid={user} default_owner_sid={default_owner}')


def _bind(dll, name, result, args):
    fn = getattr(dll, name)
    fn.restype, fn.argtypes = result, args
    return fn


def _api():
    global _API
    if _API is None:
        if os.name != 'nt':
            raise PrivateStorageError(0, 'windows-required')
        adv = ctypes.WinDLL('advapi32', use_last_error=True)
        kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        ptr = ctypes.c_void_p
        pp = ctypes.POINTER(ptr)
        _bind(kernel, 'GetCurrentProcess', w.HANDLE, [])
        _bind(kernel, 'CloseHandle', w.BOOL, [w.HANDLE])
        _bind(kernel, 'LocalFree', ptr, [ptr])
        _bind(adv, 'OpenProcessToken', w.BOOL, [w.HANDLE, w.DWORD, ctypes.POINTER(w.HANDLE)])
        _bind(adv, 'GetTokenInformation', w.BOOL, [w.HANDLE, ctypes.c_int, ptr, w.DWORD, ctypes.POINTER(w.DWORD)])
        _bind(adv, 'ConvertSidToStringSidW', w.BOOL, [ptr, ctypes.POINTER(w.LPWSTR)])
        _bind(adv, 'IsValidSid', w.BOOL, [ptr])
        _bind(adv, 'GetNamedSecurityInfoW', w.DWORD, [w.LPWSTR, ctypes.c_int, w.DWORD, pp, pp, pp, pp, pp])
        _bind(adv, 'SetNamedSecurityInfoW', w.DWORD, [w.LPWSTR, ctypes.c_int, w.DWORD, ptr, ptr, ptr, ptr])
        _bind(adv, 'GetSecurityDescriptorControl', w.BOOL, [ptr, ctypes.POINTER(w.WORD), ctypes.POINTER(w.DWORD)])
        _bind(adv, 'GetSecurityDescriptorOwner', w.BOOL, [ptr, pp, ctypes.POINTER(w.BOOL)])
        _bind(adv, 'GetSecurityDescriptorDacl', w.BOOL, [ptr, ctypes.POINTER(w.BOOL), pp, ctypes.POINTER(w.BOOL)])
        _bind(adv, 'ConvertStringSecurityDescriptorToSecurityDescriptorW', w.BOOL, [w.LPCWSTR, w.DWORD, pp, ctypes.POINTER(w.DWORD)])
        _bind(adv, 'GetAclInformation', w.BOOL, [ptr, ptr, w.DWORD, ctypes.c_int])
        _bind(adv, 'GetAce', w.BOOL, [ptr, w.DWORD, pp])
        _API = adv, kernel
    return _API


def _sid_text(sid):
    adv, kernel = _api()
    if not sid or not adv.IsValidSid(sid):
        raise PrivateStorageError(0, 'invalid-sid')
    text = w.LPWSTR()
    if not adv.ConvertSidToStringSidW(sid, ctypes.byref(text)):
        raise PrivateStorageError(ctypes.get_last_error(), 'sid-conversion')
    try:
        return text.value
    finally:
        kernel.LocalFree(ctypes.cast(text, ctypes.c_void_p))


def _identity():
    adv, kernel = _api()
    token = w.HANDLE()
    if not adv.OpenProcessToken(kernel.GetCurrentProcess(), 0x8, ctypes.byref(token)):  # TOKEN_QUERY
        raise PrivateStorageError(ctypes.get_last_error(), 'process-token')
    try:
        def sid_info(kind):
            size = w.DWORD()
            adv.GetTokenInformation(token, kind, None, 0, ctypes.byref(size))
            if not 0 < size.value <= 65536:
                raise PrivateStorageError(ctypes.get_last_error(), 'token-info-size')
            buffer = ctypes.create_string_buffer(size.value)
            if not adv.GetTokenInformation(token, kind, buffer, size, ctypes.byref(size)):
                raise PrivateStorageError(ctypes.get_last_error(), 'token-info')
            # TOKEN_USER begins with SID_AND_ATTRIBUTES; TOKEN_OWNER begins
            # with PSID. In both structures the first member is a SID pointer.
            return _sid_text(ctypes.cast(buffer, ctypes.POINTER(ctypes.c_void_p)).contents.value)
        return sid_info(1), sid_info(4)  # TokenUser, TokenOwner (default owner)
    finally:
        kernel.CloseHandle(token)


@contextmanager
def _security(path):
    adv, kernel = _api()
    owner, dacl, descriptor = ctypes.c_void_p(), ctypes.c_void_p(), ctypes.c_void_p()
    code = adv.GetNamedSecurityInfoW(str(path), 1, OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
                                     ctypes.byref(owner), None, ctypes.byref(dacl), None, ctypes.byref(descriptor))
    if code:
        raise PrivateStorageError(code, 'read-security')
    try:
        yield _sid_text(owner), descriptor, dacl
    finally:
        kernel.LocalFree(descriptor)


def _assert_private(owner, descriptor, dacl, user, default_owner, directory):
    adv, _ = _api()
    def fail(reason, code=0):
        raise PrivateStorageError(code, reason, user, default_owner, owner)
    if owner != user:
        fail('owner-mismatch')
    control, revision = w.WORD(), w.DWORD()
    if not adv.GetSecurityDescriptorControl(descriptor, ctypes.byref(control), ctypes.byref(revision)):
        fail('descriptor-control', ctypes.get_last_error())
    if not control.value & SE_DACL_PROTECTED:
        fail('inherited-acl')
    if not dacl:
        fail('null-dacl')
    class AclSize(ctypes.Structure):
        _fields_ = [('AceCount', w.DWORD), ('AclBytesInUse', w.DWORD), ('AclBytesFree', w.DWORD)]
    size = AclSize()
    if not adv.GetAclInformation(dacl, ctypes.byref(size), ctypes.sizeof(size), 2):
        fail('acl-info', ctypes.get_last_error())
    if size.AceCount != 1:
        fail('unexpected-ace-count')
    ace = ctypes.c_void_p()
    if not adv.GetAce(dacl, 0, ctypes.byref(ace)):
        fail('read-ace', ctypes.get_last_error())
    class AceHeader(ctypes.Structure):
        _fields_ = [('type', w.BYTE), ('flags', w.BYTE), ('size', w.WORD)]
    header = ctypes.cast(ace, ctypes.POINTER(AceHeader)).contents
    # One explicit ACCESS_ALLOWED_ACE, user FullControl only. Directory rules
    # propagate to files/subdirectories; a file rule propagates nowhere.
    if header.type != 0 or header.flags != (3 if directory else 0) or header.size < 16:
        fail('unexpected-ace')
    mask = ctypes.cast(ace.value + 4, ctypes.POINTER(w.DWORD)).contents.value
    if mask != FILE_ALL_ACCESS or _sid_text(ace.value + 8) != user:
        fail('foreign-or-incomplete-allow')


def protect_path(path, *, directory=False, verify=False, new=False):
    """Require user ownership; normalize default ownership only for proven new paths."""
    path = Path(path)
    if path.is_symlink() or getattr(path, 'is_junction', lambda: False)():
        raise PrivateStorageError(0, 'linked-storage')
    if path.is_dir() != directory:
        raise PrivateStorageError(0, 'unexpected-path-type')
    adv, kernel = _api()
    user, default_owner = _identity()
    with _security(path) as (owner, descriptor, dacl):
        if verify:
            _assert_private(owner, descriptor, dacl, user, default_owner, directory)
            return True
        if owner != user and not (new and owner == default_owner):
            raise PrivateStorageError(2, 'owner-mismatch', user, default_owner, owner)
    sddl = f'O:{user}D:P(A;{"OICI" if directory else ""};FA;;;{user})'
    fresh, length = ctypes.c_void_p(), w.DWORD()
    if not adv.ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, 1, ctypes.byref(fresh), ctypes.byref(length)):
        raise PrivateStorageError(ctypes.get_last_error(), 'build-private-descriptor', user, default_owner, owner)
    try:
        new_owner, new_dacl = ctypes.c_void_p(), ctypes.c_void_p()
        defaulted, present = w.BOOL(), w.BOOL()
        if not adv.GetSecurityDescriptorOwner(fresh, ctypes.byref(new_owner), ctypes.byref(defaulted)):
            raise PrivateStorageError(ctypes.get_last_error(), 'descriptor-owner', user, default_owner, owner)
        if not adv.GetSecurityDescriptorDacl(fresh, ctypes.byref(present), ctypes.byref(new_dacl), ctypes.byref(defaulted)) or not present:
            raise PrivateStorageError(ctypes.get_last_error(), 'descriptor-dacl', user, default_owner, owner)
        flags = DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION
        if owner != user:  # Proven new path with the process's default owner.
            flags |= OWNER_SECURITY_INFORMATION
        code = adv.SetNamedSecurityInfoW(str(path), 1, flags, new_owner if owner != user else None, None, new_dacl, None)
        if code:
            raise PrivateStorageError(code, 'write-private-security', user, default_owner, owner)
    finally:
        kernel.LocalFree(fresh)
    with _security(path) as (owner, descriptor, dacl):
        _assert_private(owner, descriptor, dacl, user, default_owner, directory)
    return True
