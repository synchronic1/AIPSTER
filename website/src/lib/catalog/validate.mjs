/* Built with Meta Muse. */
// Asset validator: pure structural checks over an explicit file manifest +
// bounded byte peeks. NEVER instantiates or executes a model: headers and
// shard indexes are parsed with hard size/count caps, and anything
// executable, pickle-serialized, or remote-code-requiring is rejected.
// Runs identically against R2 bytes (production) and the fixture memory
// store (tests); the caller supplies bounded reads.
export const VALIDATOR_VERSION = 'catalog-validate/1.0';
export const MAX_MANIFEST_FILES = 2000;
export const MAX_MANIFEST_BYTES = 1024 * 1024;
export const MAX_HEADER_PEEK = 64 * 1024;
export const MAX_FILE_BYTES = 100 * 1024 * 1024 * 1024;
export const MAX_ASSET_BYTES = 500 * 1024 * 1024 * 1024;

// Allowed data-file suffixes for the initial matrix. Archives are refused
// outright until bounded extraction exists; executables/scripts are refused.
const ALLOWED_SUFFIXES = ['.safetensors', '.gguf', '.json', '.txt', '.md', '.model', '.vocab', '.merges'];
const REFUSED_SUFFIXES = ['.bin', '.pt', '.pth', '.ckpt', '.pkl', '.pickle', '.dill', '.mar',
  '.zip', '.tar', '.gz', '.tgz', '.7z', '.rar', '.exe', '.dll', '.so', '.dylib', '.sh', '.py', '.js'];

function check(code, ok, message, resolve = '') {
  return { code, ok, message, resolve };
}

// Server-side traversal/symlink/name policy (T5). relpath must be a
// relative posix path: no leading slash, no drive, no '..' segment, no
// empty segment, no backslash, bounded length. Archive/symlink entries
// cannot be expressed here at all: manifests are explicit file lists.
export function validateRelPath(relpath) {
  if (typeof relpath !== 'string' || !relpath || relpath.length > 512) return 'empty or overlong name';
  if (relpath.includes('\\')) return 'backslashes refused';
  if (relpath.startsWith('/') || /^[A-Za-z]:/.test(relpath)) return 'absolute path refused';
  const segs = relpath.split('/');
  if (segs.some((s) => !s || s === '.' || s === '..')) return 'empty, dot, or dot-dot segment refused';
  if (segs.some((s) => s.length > 200)) return 'overlong segment refused';
  return null;
}

function suffixOf(name) {
  const i = name.toLowerCase().lastIndexOf('.');
  return i >= 0 ? name.toLowerCase().slice(i) : '';
}

function hasAllowedSuffix(name) {
  return ALLOWED_SUFFIXES.some((s) => name.toLowerCase().endsWith(s));
}

function hasRefusedSuffix(name) {
  return REFUSED_SUFFIXES.some((s) => name.toLowerCase().endsWith(s));
}

// Magic-number screen over the first bytes (bounded peek). Catches
// mislabeled executables and pickle payloads regardless of suffix.
export function screenMagic(peek) {
  if (!peek || !peek.length) return 'empty file';
  const b = peek.length > 16 ? peek.slice(0, 16) : peek;
  if (b[0] === 0x7f && b[1] === 0x45 && b[2] === 0x4c && b[3] === 0x46) return 'ELF executable refused';
  if (b[0] === 0x4d && b[1] === 0x5a) return 'Windows executable refused';
  if (b[0] === 0x23 && b[1] === 0x21) return 'shebang script refused';
  if (b[0] === 0x80 && b[1] >= 0x02 && b[1] <= 0x05) return 'pickle opcode refused: use safetensors';
  if (b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04) return 'zip container refused: upload explicit files';
  return null;
}

// Minimal safetensors header validation: u64LE header length + JSON header
// with data offsets inside the file. Bounded: header must fit the peek.
export function screenSafetensors(relpath, size, peek) {
  if (!relpath.toLowerCase().endsWith('.safetensors')) return null;
  if (!peek || peek.length < 8) return 'safetensors header truncated';
  const view = new DataView(peek.buffer, peek.byteOffset, 8);
  const hlen = Number(view.getBigUint64(0, true));
  if (!Number.isSafeInteger(hlen) || hlen > MAX_HEADER_PEEK || hlen + 8 > size) return 'safetensors header length implausible';
  if (peek.length < 8 + hlen) return 'safetensors header exceeds peek; re-read bounded';
  let header;
  try {
    header = JSON.parse(new TextDecoder().decode(peek.slice(8, 8 + hlen)));
  } catch {
    return 'safetensors header is not JSON';
  }
  if (!header || typeof header !== 'object') return 'safetensors header shape invalid';
  for (const [name, entry] of Object.entries(header)) {
    if (name === '__metadata__') continue;
    if (!entry || !Array.isArray(entry.data_offsets) || entry.data_offsets.length !== 2) return `tensor ${name} lacks data offsets`;
    const [a, z] = entry.data_offsets;
    if (!Number.isSafeInteger(a) || !Number.isSafeInteger(z) || a < 0 || z < a || 8 + hlen + z > size) {
      return `tensor ${name} offsets escape the file`;
    }
  }
  return null;
}

// Shard-index consistency: every weight file the index names must be
// present with matching byte counts, and every weight file present must
// be named (no silent extras, no silent gaps).
export function checkShardIndex(manifestFiles, indexJson) {
  let index;
  try {
    index = typeof indexJson === 'string' ? JSON.parse(indexJson) : indexJson;
  } catch {
    return 'shard index is not JSON';
  }
  const map = (index && index.weight_map) || {};
  if (!map || typeof map !== 'object' || !Object.keys(map).length) return 'shard index has no weight map';
  const named = new Set(Object.values(map).map(String));
  const present = new Set(manifestFiles.filter((f) => f.relpath.endsWith('.safetensors')).map((f) => f.relpath.split('/').pop()));
  for (const n of named) {
    if (!present.has(n)) return `shard index names missing file ${n}`;
  }
  for (const f of manifestFiles) {
    const base = f.relpath.split('/').pop();
    if (f.relpath.endsWith('.safetensors') && !named.has(base)) return `weight file ${base} is unnamed by the shard index`;
  }
  const total = Number(index.metadata && index.metadata.total_size);
  if (Number.isSafeInteger(total)) {
    const sum = manifestFiles.filter((f) => f.relpath.endsWith('.safetensors')).reduce((n, f) => n + f.bytes, 0);
    if (sum !== total) return `shard bytes ${sum} disagree with index total ${total}`;
  }
  return null;
}

// Full manifest validation. `peek(relpath)` returns up to MAX_HEADER_PEEK
// leading bytes or null when the file is absent. Returns { ok, checks[] }
// with per-check results; ok is false if any check fails.
export function validateManifest(manifest, peek = () => null, opts = {}) {
  const checks = [];
  const files = manifest && Array.isArray(manifest.files) ? manifest.files : null;
  if (!files) {
    checks.push(check('MANIFEST_SHAPE', false, 'Manifest must carry a files array.'));
    return { ok: false, checks, version: VALIDATOR_VERSION };
  }
  if (files.length === 0) checks.push(check('MANIFEST_EMPTY', false, 'Manifest names no files.'));
  if (files.length > MAX_MANIFEST_FILES) checks.push(check('MANIFEST_COUNT', false, `Manifest names ${files.length} files; at most ${MAX_MANIFEST_FILES}.`));
  const seen = new Set();
  let total = 0;
  let indexFile = null;
  for (const f of files) {
    const bad = validateRelPath(f && f.relpath);
    if (bad) {
      checks.push(check('PATH_POLICY', false, `Refused name ${JSON.stringify((f && f.relpath) || '')}: ${bad}.`));
      continue;
    }
    if (seen.has(f.relpath)) checks.push(check('PATH_DUP', false, `Duplicate manifest entry ${f.relpath}.`));
    seen.add(f.relpath);
    if (!Number.isSafeInteger(f.bytes) || f.bytes < 0) {
      checks.push(check('SIZE_SHAPE', false, `Unusable byte count for ${f.relpath}.`));
      continue;
    }
    if (f.bytes === 0) checks.push(check('SIZE_ZERO', false, `Empty file ${f.relpath}.`));
    if (f.bytes > MAX_FILE_BYTES) checks.push(check('SIZE_FILE_CAP', false, `${f.relpath} exceeds the per-file cap.`));
    total += f.bytes;
    if (hasRefusedSuffix(f.relpath)) {
      checks.push(check('SUFFIX_REFUSED', false, `${f.relpath}: this suffix is outside the support matrix (no archives, executables, scripts, or pickle weights).`));
      continue;
    }
    if (!hasAllowedSuffix(f.relpath)) {
      checks.push(check('SUFFIX_UNKNOWN', false, `${f.relpath}: suffix is not in the allowed data set.`));
      continue;
    }
    const head = peek(f.relpath);
    if (head === null) {
      checks.push(check('BYTES_MISSING', false, `Manifest names ${f.relpath} but no bytes arrived.`));
      continue;
    }
    const magic = screenMagic(head);
    if (magic) {
      checks.push(check('MAGIC_REFUSED', false, `${f.relpath}: ${magic}.`));
      continue;
    }
    const st = screenSafetensors(f.relpath, f.bytes, head);
    if (st) checks.push(check('SAFETENSORS_SHAPE', false, `${f.relpath}: ${st}.`));
    if (f.relpath.toLowerCase().endsWith('.index.json')) indexFile = f.relpath;
  }
  if (total > MAX_ASSET_BYTES) checks.push(check('SIZE_ASSET_CAP', false, `Asset totals ${total} bytes; at most ${MAX_ASSET_BYTES}.`));
  if (indexFile) {
    const head = peek(indexFile);
    if (head === null) {
      checks.push(check('SHARD_INDEX_MISSING', false, 'Shard index names bytes that never arrived.'));
    } else {
      const text = new TextDecoder().decode(head.slice(0, MAX_MANIFEST_BYTES));
      const err = checkShardIndex(files, text);
      if (err) checks.push(check('SHARD_INDEX', false, err));
    }
  }
  if (opts.adapter) {
    const a = opts.adapter;
    if (!a.baseAssetId || !a.baseRevision) {
      checks.push(check('ADAPTER_BASE_UNBOUND', false, 'Adapters must declare an exact base asset id and revision.'));
    }
    if (!Array.isArray(a.targetModules) || !a.targetModules.length) {
      checks.push(check('ADAPTER_MODULES_UNDECLARED', false, 'Adapters must declare target modules.'));
    }
    if (!a.tokenizer) checks.push(check('ADAPTER_TOKENIZER_UNDECLARED', false, 'Adapters must declare tokenizer assumptions.'));
  }
  if (!checks.length) checks.push(check('MANIFEST_OK', true, `${files.length} files, ${total} bytes, all structural checks passed.`));
  return { ok: checks.every((c) => c.ok), checks, version: VALIDATOR_VERSION };
}
